// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Secp256k1HdWallet } from '@cosmjs/amino';
import { toBase64 } from '@cosmjs/encoding';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRelayConfig } from './config.mjs';
import { createRelay } from './relay.mjs';

const ORIGIN = 'http://barney.test';
const CHAIN_ID = 'manifest-test';
const API_KEY = 'operator-secret-never-expose';
const CHAT_BODY = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
};

async function signMessage(wallet, address, message) {
  const result = await wallet.signAmino(address, {
    chain_id: '',
    account_number: '0',
    sequence: '0',
    fee: { gas: '0', amount: [] },
    msgs: [{
      type: 'sign/MsgSignData',
      value: {
        signer: address,
        data: toBase64(new TextEncoder().encode(message)),
      },
    }],
    memo: '',
  });
  return {
    pubKey: result.signature.pub_key.value,
    signature: result.signature.signature,
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendCompletion(response, usage = { prompt_tokens: 2, completion_tokens: 3 }) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\n`);
  response.end(`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`);
}

async function authenticate(harness, wallet) {
  const [{ address }] = await wallet.getAccounts();
  const challengeResponse = await fetch(`${harness.relayUrl}/api/morpheus/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ address, chainId: CHAIN_ID }),
  });
  expect(challengeResponse.status).toBe(200);
  const challenge = await challengeResponse.json();
  const signed = await signMessage(wallet, address, challenge.message);
  const sessionResponse = await fetch(`${harness.relayUrl}/api/morpheus/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ challengeId: challenge.challengeId, ...signed }),
  });
  expect(sessionResponse.status).toBe(200);
  return {
    address,
    cookie: sessionResponse.headers.get('set-cookie').split(';', 1)[0],
    session: await sessionResponse.json(),
    challenge,
    signed,
  };
}

function authenticatedHeaders(auth, includeOrigin = true) {
  return {
    'Content-Type': 'application/json',
    Cookie: auth.cookie,
    'X-Barney-Wallet-Address': auth.address,
    'X-Barney-Chain-Id': CHAIN_ID,
    ...(includeOrigin ? { Origin: ORIGIN } : {}),
  };
}

async function makeHarness({ config: configOverrides = {}, now, upstreamHandler } = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'barney-relay-integration-'));
  const upstreamRequests = [];
  const upstream = createServer(async (request, response) => {
    const record = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: await jsonBody(request).catch(() => undefined),
    };
    upstreamRequests.push(record);
    if (upstreamHandler) await upstreamHandler(request, response, record, upstreamRequests.length);
    else sendCompletion(response);
  });
  const upstreamUrl = await listen(upstream);
  const config = {
    ...loadRelayConfig({
      PUBLIC_MORPHEUS_URL: `${upstreamUrl}/api/v1`,
      PUBLIC_MORPHEUS_MODEL: 'test-model',
      PUBLIC_CHAIN_ID: CHAIN_ID,
      MORPHEUS_API_KEY: API_KEY,
      MORPHEUS_RELAY_ALLOWED_ORIGINS: ORIGIN,
      MORPHEUS_RELAY_IDENTITY_HMAC_KEY: 'test-identity-hmac-key-with-at-least-32-bytes',
      MORPHEUS_RELAY_STATE_FILE: join(stateDirectory, 'ledger.json'),
      MORPHEUS_RELAY_COOKIE_SECURE: 'false',
      MORPHEUS_RELAY_MAX_OUTPUT_TOKENS: '10',
      MORPHEUS_RELAY_MAX_CONTEXT_TOKENS: '1000000',
      MORPHEUS_RELAY_IDENTITY_DAILY_REQUESTS: '100',
      MORPHEUS_RELAY_IDENTITY_DAILY_TOKENS: '10000000',
      MORPHEUS_RELAY_IDENTITY_DAILY_SPEND_MICRO_USD: '10000000',
      MORPHEUS_RELAY_PROVIDER_DAILY_BUDGET_MICRO_USD: '100000000',
      MORPHEUS_RELAY_INPUT_MICRO_USD_PER_MILLION_TOKENS: '1000000',
      MORPHEUS_RELAY_OUTPUT_MICRO_USD_PER_MILLION_TOKENS: '2000000',
    }),
    ...configOverrides,
  };
  const logs = [];
  const relay = await createRelay({ config, now, logger: (entry) => logs.push(entry) });
  const relayAddress = await relay.listen(0, '127.0.0.1');
  return {
    config,
    logs,
    relay,
    relayUrl: `http://127.0.0.1:${relayAddress.port}`,
    upstream,
    upstreamRequests,
    async close() {
      await relay.close();
      upstream.closeAllConnections();
      upstream.close();
      await once(upstream, 'close');
    },
  };
}

const harnesses = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

async function harness(options) {
  const result = await makeHarness(options);
  harnesses.push(result);
  return result;
}

describe('authenticated Morpheus relay', () => {
  it('rejects a no-Origin anonymous client before contacting the paid upstream', async () => {
    const app = await harness();
    const response = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CHAT_BODY),
    });

    expect(response.status).toBe(401);
    expect(app.upstreamRequests).toHaveLength(0);
  });

  it('accepts an authenticated no-Origin client and injects the key only upstream', async () => {
    const app = await harness();
    const auth = await authenticate(app, await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }));
    const response = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST',
      headers: authenticatedHeaders(auth, false),
      body: JSON.stringify(CHAT_BODY),
    });

    expect(response.status).toBe(200);
    const browserBody = await response.text();
    expect(browserBody).not.toContain(API_KEY);
    expect(app.upstreamRequests).toHaveLength(1);
    expect(app.upstreamRequests[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      authorization: `Bearer ${API_KEY}`,
    });
  });

  it('rejects invalid and replayed one-time credentials', async () => {
    const app = await harness();
    const wallet = await Secp256k1HdWallet.generate(12, { prefix: 'manifest' });
    const [{ address }] = await wallet.getAccounts();
    const challengeResponse = await fetch(`${app.relayUrl}/api/morpheus/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ address, chainId: CHAIN_ID }),
    });
    const challenge = await challengeResponse.json();
    const signed = await signMessage(wallet, address, challenge.message);
    const invalid = `${signed.signature[0] === 'A' ? 'B' : 'A'}${signed.signature.slice(1)}`;

    const invalidResponse = await fetch(`${app.relayUrl}/api/morpheus/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ challengeId: challenge.challengeId, pubKey: signed.pubKey, signature: invalid }),
    });
    expect(invalidResponse.status).toBe(401);

    const replayResponse = await fetch(`${app.relayUrl}/api/morpheus/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ challengeId: challenge.challengeId, ...signed }),
    });
    expect(replayResponse.status).toBe(401);
  });

  it('fails closed on wallet switch, logout, and session expiry', async () => {
    let clock = Date.parse('2026-08-27T12:00:00Z');
    const app = await harness({ now: () => clock, config: { sessionTtlMs: 1000 } });
    const wallet = await Secp256k1HdWallet.generate(12, { prefix: 'manifest' });
    const otherWallet = await Secp256k1HdWallet.generate(12, { prefix: 'manifest' });
    const [{ address: otherAddress }] = await otherWallet.getAccounts();
    const auth = await authenticate(app, wallet);

    const switched = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST',
      headers: { ...authenticatedHeaders(auth), 'X-Barney-Wallet-Address': otherAddress },
      body: JSON.stringify(CHAT_BODY),
    });
    expect(switched.status).toBe(403);

    const logout = await fetch(`${app.relayUrl}/api/morpheus/auth/logout`, {
      method: 'DELETE',
      headers: { Cookie: auth.cookie, Origin: ORIGIN },
    });
    expect(logout.status).toBe(204);
    const loggedOut = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST',
      headers: authenticatedHeaders(auth),
      body: JSON.stringify(CHAT_BODY),
    });
    expect(loggedOut.status).toBe(401);

    const expiring = await authenticate(app, wallet);
    clock += 1001;
    const expired = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST',
      headers: authenticatedHeaders(expiring),
      body: JSON.stringify(CHAT_BODY),
    });
    expect(expired.status).toBe(401);
    expect(app.upstreamRequests).toHaveLength(0);
  });

  it('allows only the required path, method, and configured model', async () => {
    const app = await harness();
    const auth = await authenticate(app, await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }));

    expect((await fetch(`${app.relayUrl}/api/morpheus/models`)).status).toBe(404);
    expect((await fetch(`${app.relayUrl}/api/morpheus/chat/completions`)).status).toBe(405);
    const model = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST',
      headers: authenticatedHeaders(auth),
      body: JSON.stringify({ ...CHAT_BODY, model: 'unpaid-model' }),
    });
    expect(model.status).toBe(403);
    expect(app.upstreamRequests).toHaveLength(0);
  });

  it('rejects oversized bodies and prompt/context before upstream access', async () => {
    const app = await harness({ config: { maxRequestBodyBytes: 256, maxPromptChars: 4 } });
    const auth = await authenticate(app, await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }));
    const oversized = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST',
      headers: authenticatedHeaders(auth),
      body: JSON.stringify({ ...CHAT_BODY, padding: 'x'.repeat(500) }),
    });
    expect(oversized.status).toBe(413);

    const prompt = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST',
      headers: authenticatedHeaders(auth),
      body: JSON.stringify(CHAT_BODY),
    });
    expect(prompt.status).toBe(413);
    expect(app.upstreamRequests).toHaveLength(0);

    const contextApp = await harness({
      config: { maxRequestBodyBytes: 4096, maxPromptChars: 1000, maxContextTokens: 32 },
    });
    const contextAuth = await authenticate(
      contextApp,
      await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }),
    );
    const context = await fetch(`${contextApp.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST',
      headers: authenticatedHeaders(contextAuth),
      body: JSON.stringify(CHAT_BODY),
    });
    expect(context.status).toBe(413);
    expect(contextApp.upstreamRequests).toHaveLength(0);
  });

  it('caps output tokens and settles durable reservations from provider usage', async () => {
    const app = await harness({
      upstreamHandler: async (_request, response) => {
        // Ambiguous cost fields must not override explicitly configured USD
        // pricing. Only a provider field named *_usd is accepted as dollars.
        sendCompletion(response, { prompt_tokens: 2, completion_tokens: 3, total_cost: 999 });
      },
    });
    const auth = await authenticate(app, await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }));
    const response = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST',
      headers: authenticatedHeaders(auth),
      body: JSON.stringify({ ...CHAT_BODY, max_tokens: 999 }),
    });
    await response.text();

    expect(app.upstreamRequests[0].body).toMatchObject({
      model: 'test-model',
      max_tokens: 10,
      stream: true,
      stream_options: { include_usage: true },
    });
    await vi.waitFor(() => {
      expect(app.relay.ledger.snapshot().provider).toEqual({
        requests: 1,
        tokens: 5,
        spendMicroUsd: 8,
      });
    });
  });

  it('enforces per-identity request quota and the provider hard budget before fetch', async () => {
    const quotaApp = await harness({ config: { identityDailyRequests: 1 } });
    const auth = await authenticate(quotaApp, await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }));
    const first = await fetch(`${quotaApp.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST', headers: authenticatedHeaders(auth), body: JSON.stringify(CHAT_BODY),
    });
    await first.text();
    const second = await fetch(`${quotaApp.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST', headers: authenticatedHeaders(auth), body: JSON.stringify(CHAT_BODY),
    });
    expect(second.status).toBe(429);
    expect(quotaApp.upstreamRequests).toHaveLength(1);

    const budgetApp = await harness({ config: { providerDailyBudgetMicroUsd: 1 } });
    const budgetAuth = await authenticate(budgetApp, await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }));
    const budget = await fetch(`${budgetApp.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST', headers: authenticatedHeaders(budgetAuth), body: JSON.stringify(CHAT_BODY),
    });
    expect(budget.status).toBe(503);
    expect(budgetApp.upstreamRequests).toHaveLength(0);
  });

  it('enforces per-identity concurrency', async () => {
    let releaseFirst;
    const release = new Promise((resolve) => { releaseFirst = resolve; });
    let enteredFirst;
    const entered = new Promise((resolve) => { enteredFirst = resolve; });
    const app = await harness({
      config: { maxIdentityConcurrent: 1 },
      upstreamHandler: async (_request, response, _record, number) => {
        if (number === 1) {
          enteredFirst();
          await release;
        }
        sendCompletion(response);
      },
    });
    const auth = await authenticate(app, await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }));
    const firstPromise = fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST', headers: authenticatedHeaders(auth), body: JSON.stringify(CHAT_BODY),
    });
    await entered;
    const second = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST', headers: authenticatedHeaders(auth), body: JSON.stringify(CHAT_BODY),
    });
    expect(second.status).toBe(429);
    releaseFirst();
    const first = await firstPromise;
    await first.text();
    expect(app.upstreamRequests).toHaveLength(1);
  });

  it('enforces provider-wide concurrency across different wallets', async () => {
    let releaseFirst;
    const release = new Promise((resolve) => { releaseFirst = resolve; });
    let enteredFirst;
    const entered = new Promise((resolve) => { enteredFirst = resolve; });
    const app = await harness({
      config: { maxProviderConcurrent: 1 },
      upstreamHandler: async (_request, response, _record, number) => {
        if (number === 1) {
          enteredFirst();
          await release;
        }
        sendCompletion(response);
      },
    });
    const firstAuth = await authenticate(app, await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }));
    const secondAuth = await authenticate(app, await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }));
    const firstPromise = fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST', headers: authenticatedHeaders(firstAuth), body: JSON.stringify(CHAT_BODY),
    });
    await entered;
    const second = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST', headers: authenticatedHeaders(secondAuth), body: JSON.stringify(CHAT_BODY),
    });
    expect(second.status).toBe(503);
    releaseFirst();
    await (await firstPromise).text();
    expect(app.upstreamRequests).toHaveLength(1);
  });

  it('bounds upstream connection time and keeps the reservation charged on uncertainty', async () => {
    const app = await harness({
      config: { upstreamConnectTimeoutMs: 30, streamTimeoutMs: 100 },
      upstreamHandler: async (request) => {
        await once(request, 'close');
      },
    });
    const auth = await authenticate(app, await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }));
    const response = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST', headers: authenticatedHeaders(auth), body: JSON.stringify(CHAT_BODY),
    });

    expect(response.status).toBe(504);
    expect(app.upstreamRequests).toHaveLength(1);
    expect(app.relay.ledger.snapshot().provider.spendMicroUsd).toBeGreaterThan(0);
  });

  it('keeps the full reservation when upstream explicitly rejects without usage', async () => {
    const app = await harness({
      upstreamHandler: async (_request, response) => {
        response.writeHead(429, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: `provider detail ${API_KEY}` }));
      },
    });
    const auth = await authenticate(app, await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }));
    const response = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST', headers: authenticatedHeaders(auth), body: JSON.stringify(CHAT_BODY),
    });

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(API_KEY);
    expect(app.relay.ledger.snapshot().provider.spendMicroUsd).toBeGreaterThan(0);
    expect(JSON.stringify(app.logs)).not.toContain(API_KEY);
  });

  it('aborts an active paid request when its wallet session logs out', async () => {
    let enteredUpstream;
    const entered = new Promise((resolve) => { enteredUpstream = resolve; });
    const app = await harness({
      upstreamHandler: async (request) => {
        enteredUpstream();
        await once(request, 'close');
      },
    });
    const auth = await authenticate(app, await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }));
    const completionPromise = fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST', headers: authenticatedHeaders(auth), body: JSON.stringify(CHAT_BODY),
    });
    await entered;
    const logout = await fetch(`${app.relayUrl}/api/morpheus/auth/logout`, {
      method: 'DELETE', headers: { Cookie: auth.cookie, Origin: ORIGIN },
    });
    const completion = await completionPromise;

    expect(logout.status).toBe(204);
    expect(completion.status).toBe(504);
    expect(app.relay.ledger.snapshot().provider.spendMicroUsd).toBeGreaterThan(0);
  });

  it('terminates a paid stream at the configured total-duration bound', async () => {
    const app = await harness({
      config: { streamTimeoutMs: 30 },
      upstreamHandler: async (request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.flushHeaders();
        await once(request, 'close');
      },
    });
    const auth = await authenticate(app, await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }));
    const response = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST', headers: authenticatedHeaders(auth), body: JSON.stringify(CHAT_BODY),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('server safety limit');
    expect(app.relay.ledger.snapshot().provider.spendMicroUsd).toBeGreaterThan(0);
  });

  it('exports aggregate metrics without wallet addresses, API keys, or identity labels', async () => {
    const app = await harness();
    const auth = await authenticate(app, await Secp256k1HdWallet.generate(12, { prefix: 'manifest' }));
    const completion = await fetch(`${app.relayUrl}/api/morpheus/chat/completions`, {
      method: 'POST', headers: authenticatedHeaders(auth), body: JSON.stringify(CHAT_BODY),
    });
    await completion.text();
    const metrics = await (await fetch(`${app.relayUrl}/metrics`)).text();

    expect(metrics).toContain('barney_morpheus_relay_provider_spend_micro_usd');
    expect(metrics).not.toContain(auth.address);
    expect(metrics).not.toContain(API_KEY);
    expect(app.logs.every((entry) => !JSON.stringify(entry).includes(API_KEY))).toBe(true);
  });
});
