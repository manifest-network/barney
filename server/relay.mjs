import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  AuthError,
  ChallengeStore,
  SessionStore,
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
  verifyAdr36,
} from './auth.mjs';
import { loadRelayConfig, upstreamChatUrl } from './config.mjs';
import { estimateSpendMicroUsd, QuotaError, QuotaLedger } from './ledger.mjs';
import { RelayMetrics } from './metrics.mjs';
import {
  RequestError,
  readJson,
  requireAllowedOrigin,
  validateChatRequest,
} from './validation.mjs';

const API_PREFIX = '/api/morpheus';

function safeLogger(entry) {
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    component: 'barney-morpheus-relay',
    ...entry,
  })}\n`);
}

function json(response, status, body, extraHeaders = {}) {
  if (response.headersSent || response.destroyed) return;
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': encoded.length,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(encoded);
}

function text(response, status, body, contentType) {
  if (response.headersSent || response.destroyed) return;
  const encoded = Buffer.from(body);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Content-Length': encoded.length,
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(encoded);
}

function stringHeader(request, name) {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

function assertObjectWithKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'request_invalid', 'Request body must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new RequestError(400, 'parameter_denied', `Unsupported parameter: ${key}`);
  }
}

class ConcurrencyGate {
  constructor(config) {
    this.config = config;
    this.providerActive = 0;
    this.identityActive = new Map();
  }

  acquire(identityKey) {
    const identityCount = this.identityActive.get(identityKey) ?? 0;
    if (identityCount >= this.config.maxIdentityConcurrent) {
      throw new QuotaError(429, 'identity_concurrency', 'Concurrent inference request limit reached');
    }
    if (this.providerActive >= this.config.maxProviderConcurrent) {
      throw new QuotaError(503, 'provider_concurrency', 'Inference is temporarily at capacity');
    }
    this.providerActive += 1;
    this.identityActive.set(identityKey, identityCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.providerActive = Math.max(0, this.providerActive - 1);
      const next = (this.identityActive.get(identityKey) ?? 1) - 1;
      if (next <= 0) this.identityActive.delete(identityKey);
      else this.identityActive.set(identityKey, next);
    };
  }

  snapshot() {
    return {
      providerActive: this.providerActive,
      maxIdentityActive: Math.max(0, ...this.identityActive.values()),
    };
  }
}

class SseUsageParser {
  constructor() {
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.usage = undefined;
  }

  push(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.processLines(false);
  }

  finish() {
    this.buffer += this.decoder.decode();
    this.processLines(true);
    return this.usage;
  }

  processLines(flush) {
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = flush ? '' : (lines.pop() ?? '');
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const payload = JSON.parse(data);
        const usage = payload?.usage;
        if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens < 0
          || !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens < 0) continue;
        let spendMicroUsd;
        // Only explicitly USD-denominated fields are safe to treat as dollars.
        // Ambiguous provider fields such as `cost` may use another currency or
        // integer unit; configured per-token pricing remains the fallback.
        for (const candidate of [usage.total_cost_usd, usage.cost_usd]) {
          if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
            const converted = Math.ceil(candidate * 1_000_000);
            if (Number.isSafeInteger(converted)) spendMicroUsd = converted;
            break;
          }
        }
        this.usage = {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          spendMicroUsd,
        };
      } catch {
        // The browser owns user-visible SSE parsing. Accounting only needs valid
        // usage frames and deliberately ignores every other provider payload.
      }
    }
  }
}

function knownError(error) {
  return error instanceof AuthError || error instanceof RequestError || error instanceof QuotaError;
}

function methodAllowed(request, expected) {
  if (request.method === expected) return true;
  throw new RequestError(405, 'method_denied', 'HTTP method is not allowed');
}

function waitForDrain(response) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('downstream_closed'));
    };
    const onError = () => {
      cleanup();
      reject(new Error('downstream_write_failed'));
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
  });
}

function safeStreamError(response, message) {
  if (response.destroyed || response.writableEnded) return;
  if (!response.headersSent) {
    json(response, 504, { error: message });
    return;
  }
  response.write(`data: ${JSON.stringify({ error: { message } })}\n\ndata: [DONE]\n\n`);
  response.end();
}

/** Create an initialized relay without binding a TCP port (useful for tests). */
export async function createRelay(options = {}) {
  const config = options.config ?? loadRelayConfig();
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger ?? safeLogger;
  const challenges = new ChallengeStore(config, now);
  const sessions = new SessionStore(config, now);
  const ledger = new QuotaLedger(config, now);
  const metrics = new RelayMetrics();
  const concurrency = new ConcurrencyGate(config);
  const activeBySession = new Map();
  await ledger.init();

  function metricRequest(route, outcome) {
    metrics.increment('barney_morpheus_relay_requests_total', { route, outcome });
  }

  function metricRejection(reason) {
    metrics.increment('barney_morpheus_relay_rejections_total', { reason });
  }

  function registerActive(sessionId, abort) {
    const active = activeBySession.get(sessionId) ?? new Set();
    active.add(abort);
    activeBySession.set(sessionId, active);
    return () => {
      active.delete(abort);
      if (active.size === 0) activeBySession.delete(sessionId);
    };
  }

  function revokeSession(sessionId, reason) {
    for (const abort of activeBySession.get(sessionId) ?? []) {
      abort(reason);
    }
    activeBySession.delete(sessionId);
    sessions.revoke(sessionId);
  }

  function requireSession(request) {
    return sessions.requireBound(
      readSessionCookie(request, config),
      stringHeader(request, 'x-barney-wallet-address'),
      stringHeader(request, 'x-barney-chain-id'),
    );
  }

  async function handleChallenge(request, response) {
    methodAllowed(request, 'POST');
    requireAllowedOrigin(request, config);
    const { value } = await readJson(request, config.maxAuthBodyBytes);
    assertObjectWithKeys(value, new Set(['address', 'chainId']));
    const challenge = challenges.create(value.address, value.chainId);
    metricRequest('auth_challenge', 'success');
    json(response, 200, {
      challengeId: challenge.challengeId,
      message: challenge.message,
      address: challenge.address,
      chainId: challenge.chainId,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
    });
  }

  async function handleSessionCreate(request, response) {
    methodAllowed(request, 'POST');
    requireAllowedOrigin(request, config);
    const { value } = await readJson(request, config.maxAuthBodyBytes);
    assertObjectWithKeys(value, new Set(['challengeId', 'pubKey', 'signature']));
    const challenge = challenges.consume(value.challengeId);
    verifyAdr36({
      address: challenge.address,
      message: challenge.message,
      pubKey: value.pubKey,
      signature: value.signature,
      addressPrefix: config.addressPrefix,
    });

    const priorSessionId = readSessionCookie(request, config);
    if (priorSessionId) revokeSession(priorSessionId, 'session_replaced');
    const session = sessions.create(challenge.address, challenge.chainId);
    setSessionCookie(response, config, session);
    metricRequest('auth_session', 'success');
    json(response, 200, {
      authenticated: true,
      address: session.address,
      chainId: session.chainId,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }

  function handleSessionStatus(request, response) {
    methodAllowed(request, 'GET');
    requireAllowedOrigin(request, config);
    const session = requireSession(request);
    metricRequest('auth_status', 'success');
    json(response, 200, {
      authenticated: true,
      address: session.address,
      chainId: session.chainId,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }

  function handleLogout(request, response) {
    methodAllowed(request, 'DELETE');
    requireAllowedOrigin(request, config);
    const sessionId = readSessionCookie(request, config);
    if (sessionId) revokeSession(sessionId, 'session_logout');
    clearSessionCookie(response, config);
    metricRequest('auth_logout', 'success');
    response.writeHead(204, { 'Cache-Control': 'no-store' });
    response.end();
  }

  async function handleChat(request, response, requestId) {
    methodAllowed(request, 'POST');
    requireAllowedOrigin(request, config);
    const sessionId = readSessionCookie(request, config);
    const session = requireSession(request);
    const { value } = await readJson(request, config.maxRequestBodyBytes);
    const chat = validateChatRequest(value, config);

    let releaseConcurrency;
    let unregisterActive;
    let reservation;
    let settlement;
    let streamTimer;
    let connectTimer;
    let abortReason = 'upstream_error';
    let responseBytes = 0;
    const upstreamAbort = new AbortController();
    const onDownstreamClose = () => {
      if (!response.writableEnded) {
        abortReason = 'client_abort';
        upstreamAbort.abort(new Error('client_abort'));
      }
    };

    try {
      releaseConcurrency = concurrency.acquire(session.identityKey);
      metrics.requestStarted();
      reservation = await ledger.reserve(session.identityKey, chat.inputTokens, chat.outputTokens);
      metrics.increment('barney_morpheus_relay_reserved_tokens_total', {}, reservation.reservedTokens);
      metrics.increment('barney_morpheus_relay_reserved_spend_micro_usd_total', {}, reservation.reservedSpendMicroUsd);
      unregisterActive = registerActive(sessionId, (reason) => {
        abortReason = reason;
        upstreamAbort.abort(new Error(reason));
      });
      response.on('close', onDownstreamClose);

      const untilExpiry = Math.max(1, session.expiresAt - now());
      connectTimer = setTimeout(() => {
        abortReason = untilExpiry <= config.upstreamConnectTimeoutMs ? 'session_expired' : 'upstream_connect_timeout';
        upstreamAbort.abort(new Error(abortReason));
      }, Math.min(config.upstreamConnectTimeoutMs, untilExpiry));

      const upstreamResponse = await fetchImpl(upstreamChatUrl(config), {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chat.upstream),
        redirect: 'error',
        signal: upstreamAbort.signal,
      });
      clearTimeout(connectTimer);
      connectTimer = undefined;

      if (!upstreamResponse.ok) {
        await upstreamResponse.body?.cancel().catch(() => {});
        metricRequest('chat', 'upstream_rejected');
        logger({ level: 'warn', event: 'upstream_rejected', requestId, upstreamStatus: upstreamResponse.status });
        json(response, 502, { error: 'Upstream inference request failed' });
        return;
      }
      const contentType = upstreamResponse.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('text/event-stream')) {
        await upstreamResponse.body?.cancel().catch(() => {});
        metricRequest('chat', 'upstream_protocol_error');
        json(response, 502, { error: 'Upstream inference response was invalid' });
        return;
      }
      if (!upstreamResponse.body) {
        metricRequest('chat', 'upstream_protocol_error');
        json(response, 502, { error: 'Upstream inference response was empty' });
        return;
      }

      const streamDuration = Math.min(config.streamTimeoutMs, Math.max(1, session.expiresAt - now()));
      streamTimer = setTimeout(() => {
        abortReason = session.expiresAt - now() <= 0 ? 'session_expired' : 'stream_timeout';
        upstreamAbort.abort(new Error(abortReason));
      }, streamDuration);

      response.writeHead(200, {
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      const usageParser = new SseUsageParser();
      for await (const chunk of upstreamResponse.body) {
        responseBytes += chunk.byteLength;
        if (responseBytes > config.maxUpstreamResponseBytes) {
          abortReason = 'response_too_large';
          upstreamAbort.abort(new Error(abortReason));
          throw new RequestError(502, abortReason, 'Inference response exceeded the server limit');
        }
        usageParser.push(chunk);
        if (!response.write(chunk)) await waitForDrain(response);
      }
      const usage = usageParser.finish();
      if (usage) {
        settlement = usage;
        metrics.increment('barney_morpheus_relay_usage_tokens_total', { type: 'input' }, usage.inputTokens);
        metrics.increment('barney_morpheus_relay_usage_tokens_total', { type: 'output' }, usage.outputTokens);
        const spend = usage.spendMicroUsd ?? estimateSpendMicroUsd(config, usage.inputTokens, usage.outputTokens);
        metrics.increment('barney_morpheus_relay_usage_spend_micro_usd_total', {}, spend);
      }
      metricRequest('chat', 'success');
      response.end();
    } catch (error) {
      const aborted = upstreamAbort.signal.aborted;
      if (abortReason === 'client_abort') {
        metricRequest('chat', 'client_abort');
      } else if (aborted || (knownError(error) && response.headersSent)) {
        metricRejection(abortReason);
        metricRequest('chat', abortReason);
        safeStreamError(
          response,
          abortReason === 'session_expired'
            ? 'Wallet authentication expired during inference.'
            : abortReason.startsWith('session_') || abortReason === 'server_shutdown'
              ? 'Wallet authentication ended during inference.'
            : 'Inference request exceeded a server safety limit.',
        );
      } else if (reservation) {
        // From this point onward every unknown error is on the upstream/stream
        // side of a durable reservation. Keep the full reservation charged and
        // return a generic response that cannot expose provider details.
        metricRejection('upstream_error');
        metricRequest('chat', 'upstream_error');
        safeStreamError(response, 'Inference is temporarily unavailable.');
      } else {
        throw error;
      }
    } finally {
      if (connectTimer) clearTimeout(connectTimer);
      if (streamTimer) clearTimeout(streamTimer);
      response.off('close', onDownstreamClose);
      unregisterActive?.();
      if (releaseConcurrency) {
        releaseConcurrency();
        metrics.requestFinished();
      }
      upstreamAbort.abort(new Error('request_complete'));
      if (reservation && settlement) {
        try {
          await ledger.settle(reservation, settlement);
        } catch {
          // The durable reservation remains charged on disk if settlement
          // persistence fails. That is deliberately fail-closed for budget safety.
          logger({ level: 'error', event: 'accounting_settlement_failed', requestId });
        }
      }
    }
  }

  async function route(request, response) {
    const requestId = randomUUID();
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://relay.invalid');
    } catch {
      throw new RequestError(400, 'path_invalid', 'Invalid request path');
    }
    if (url.search) throw new RequestError(400, 'query_denied', 'Query parameters are not allowed');

    switch (url.pathname) {
      case `${API_PREFIX}/healthz`:
        methodAllowed(request, 'GET');
        json(response, 200, { status: 'ok' });
        return;
      case `${API_PREFIX}/readyz`:
        methodAllowed(request, 'GET');
        json(response, 200, { status: 'ready' });
        return;
      case '/metrics':
        methodAllowed(request, 'GET');
        text(response, 200, metrics.render(ledger.snapshot(), config, concurrency.snapshot()), 'text/plain; version=0.0.4; charset=utf-8');
        return;
      case `${API_PREFIX}/auth/challenge`:
        await handleChallenge(request, response);
        return;
      case `${API_PREFIX}/auth/session`:
        await handleSessionCreate(request, response);
        return;
      case `${API_PREFIX}/auth/status`:
        handleSessionStatus(request, response);
        return;
      case `${API_PREFIX}/auth/logout`:
        handleLogout(request, response);
        return;
      case `${API_PREFIX}/chat/completions`:
        await handleChat(request, response, requestId);
        return;
      default:
        throw new RequestError(404, 'path_denied', 'API path is not allowed');
    }
  }

  const server = createServer((request, response) => {
    route(request, response).catch((error) => {
      if (knownError(error)) {
        metricRejection(error.reason);
        metricRequest('request', 'rejected');
        json(response, error.status, { error: error.message }, {
          ...(error.status === 405 ? { Allow: 'GET, POST, DELETE' } : {}),
          ...(error instanceof AuthError ? { 'X-Barney-Auth-Required': '1' } : {}),
        });
        return;
      }
      logger({ level: 'error', event: 'request_failed', requestId: randomUUID() });
      json(response, 500, { error: 'Internal relay error' });
    });
  });

  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = Math.max(config.streamTimeoutMs + 10_000, 30_000);

  return {
    config,
    server,
    ledger,
    metrics,
    async listen(port = config.listenPort, host = config.listenHost) {
      server.listen(port, host);
      await once(server, 'listening');
      return server.address();
    },
    async close() {
      for (const sessionId of activeBySession.keys()) revokeSession(sessionId, 'server_shutdown');
      if (server.listening) {
        server.close();
        await once(server, 'close');
      }
    },
  };
}
