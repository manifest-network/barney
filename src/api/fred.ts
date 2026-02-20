/**
 * Fred API client for polling lease deployment status.
 *
 * Fred is the provider-side service that manages container deployments.
 * Its `/v1/leases/{uuid}/status` endpoint returns deployment progress and readiness.
 *
 * Follows the same patterns as provider-api.ts:
 * - SSRF validation via parseHttpUrl + isUrlSsrfSafe
 * - Dev CORS proxy via buildProviderFetchArgs
 * - ADR-036 auth tokens
 * - ProviderApiError for typed HTTP failures
 */

import { z } from 'zod';
import { ProviderApiError } from './provider-api';
import { validateProviderUrl, normalizeBaseUrl, buildValidatedProviderRequest } from './providerFetch';
import { LeaseState, leaseStateFromString, leaseStateToString } from './billing';
import { logError } from '../utils/errors';
import {
  FRED_POLL_INTERVAL_MS,
  WS_RECONNECT_DELAY_MS,
  WS_MAX_RECONNECT_ATTEMPTS,
  WS_LIVENESS_TIMEOUT_MS,
} from '../config/constants';

export interface FredInstanceInfo {
  name: string;
  status: string;
  ports?: Record<string, number>;
}

export interface FredServiceStatus {
  instances: FredInstanceInfo[];
}

export interface FredLeaseStatus {
  state: LeaseState;
  provision_status?: string;
  phase?: string;
  steps?: Record<string, string>;
  instances?: FredInstanceInfo[];
  endpoints?: Record<string, string>;
  last_error?: string;
  fail_count?: number;
  created_at?: string;
  /** Per-service status for stack (multi-service) deployments. */
  services?: Record<string, FredServiceStatus>;
}

const FredInstanceInfoSchema = z.object({
  name: z.string(),
  status: z.string(),
  ports: z.record(z.string(), z.number()).optional().catch(undefined),
});

const FredServiceStatusSchema = z.object({
  instances: z.array(z.unknown())
    .catch([])
    .transform((arr) =>
      arr.map((item) => FredInstanceInfoSchema.safeParse(item))
        .filter((r) => r.success)
        .map((r) => r.data)
    ),
});

/** Parse a record, keeping only entries with string values (matches original per-entry filtering). */
const stringRecordSchema = z.record(z.string(), z.unknown()).optional().catch(undefined)
  .transform((rec) => {
    if (!rec) return undefined;
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (typeof v === 'string') filtered[k] = v;
    }
    return Object.keys(filtered).length > 0 ? filtered : undefined;
  });

const FredLeaseStatusSchema = z.object({
  state: z.string().transform((s): LeaseState => {
    try {
      const parsed = leaseStateFromString(s);
      if (parsed !== LeaseState.UNRECOGNIZED) return parsed;
      logError(`fred: unrecognized state "${s}"`, new Error('leaseStateFromString returned UNRECOGNIZED'));
      return LeaseState.LEASE_STATE_PENDING;
    } catch (error) {
      logError(`fred: unrecognized state "${s}"`, error);
      return LeaseState.LEASE_STATE_PENDING;
    }
  }).catch(LeaseState.LEASE_STATE_PENDING as LeaseState),
  provision_status: z.string().optional().catch(undefined),
  phase: z.string().optional().catch(undefined),
  steps: stringRecordSchema,
  instances: z.array(z.unknown()).optional().catch(undefined)
    .transform((arr) =>
      arr?.map((item) => FredInstanceInfoSchema.safeParse(item))
        .filter((r) => r.success)
        .map((r) => r.data)
    ),
  endpoints: stringRecordSchema,
  last_error: z.string().optional().catch(undefined),
  fail_count: z.number().optional().catch(undefined),
  created_at: z.string().optional().catch(undefined),
  services: z.record(z.string(), FredServiceStatusSchema).optional().catch(undefined),
}).transform((raw): FredLeaseStatus => {
  const result: FredLeaseStatus = { state: raw.state };
  if (raw.provision_status !== undefined) result.provision_status = raw.provision_status;
  if (raw.phase !== undefined) result.phase = raw.phase;
  if (raw.steps !== undefined) result.steps = raw.steps;
  if (raw.instances !== undefined) result.instances = raw.instances;
  if (raw.endpoints !== undefined) result.endpoints = raw.endpoints;
  if (raw.last_error !== undefined) result.last_error = raw.last_error;
  if (raw.fail_count !== undefined) result.fail_count = raw.fail_count;
  if (raw.created_at !== undefined) result.created_at = raw.created_at;
  if (raw.services && Object.keys(raw.services).length > 0) result.services = raw.services;
  return result;
});

/** Negative terminal lease states — polling should always stop for these. */
const TERMINAL_STATES = new Set<LeaseState>([
  LeaseState.LEASE_STATE_CLOSED,
  LeaseState.LEASE_STATE_REJECTED,
  LeaseState.LEASE_STATE_EXPIRED,
]);

/** Map chain state strings to LeaseState enums for terminal detection. */
const CHAIN_STATE_MAP: Record<string, LeaseState> = {
  closed: LeaseState.LEASE_STATE_CLOSED,
  rejected: LeaseState.LEASE_STATE_REJECTED,
  expired: LeaseState.LEASE_STATE_EXPIRED,
};

/** Provision states that indicate the backend is still working — keep waiting. */
const TRANSIENT_PROVISION_STATES = new Set(['provisioning', 'updating', 'restarting']);

/**
 * Fetch the current deployment status for a lease from fred.
 *
 * @param providerApiUrl - The provider's API base URL (fred)
 * @param leaseUuid - The lease UUID to check
 * @param authToken - Base64-encoded ADR-036 auth token
 */
export async function getLeaseStatus(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string
): Promise<FredLeaseStatus> {
  const encodedLeaseUuid = encodeURIComponent(leaseUuid);
  const { url, headers } = buildValidatedProviderRequest(
    providerApiUrl,
    `/v1/leases/${encodedLeaseUuid}/status`,
    { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' }
  );

  const response = await fetch(url, { method: 'GET', headers });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new ProviderApiError(
      response.status,
      `Fred status error (${response.status}): ${errorText}`
    );
  }

  try {
    const raw = await response.json();
    return FredLeaseStatusSchema.parse(raw);
  } catch (error) {
    if (error instanceof ProviderApiError) throw error;
    throw new ProviderApiError(response.status, 'Fred returned invalid JSON');
  }
}

/** Chain lease states that indicate the lease is no longer viable */
export interface TerminalChainState {
  state: 'closed' | 'rejected' | 'expired';
}

export const LeaseLogsResponseSchema = z.object({
  lease_uuid: z.string(),
  tenant: z.string(),
  provider_uuid: z.string(),
  logs: z.record(z.string(), z.string()),
});

export type LeaseLogsResponse = z.infer<typeof LeaseLogsResponseSchema>;

export const LeaseProvisionSchema = z.object({
  status: z.string(),
  fail_count: z.number(),
  last_error: z.string(),
});

export type LeaseProvision = z.infer<typeof LeaseProvisionSchema>;

export const LeaseInfoSchema = z.object({
  host: z.string(),
  ports: z.record(z.string(), z.unknown()).optional(),
});

export type LeaseInfo = z.infer<typeof LeaseInfoSchema>;

export interface PollOptions {
  intervalMs?: number;
  maxAttempts?: number;
  onProgress?: (status: FredLeaseStatus) => void;
  abortSignal?: AbortSignal;
  /**
   * Optional callback to check chain state during polling.
   * If it returns a terminal state, polling stops with a 'failed' status.
   */
  checkChainState?: () => Promise<TerminalChainState | null>;
  /** Optional callback to mint a fresh auth token for each poll request. */
  getAuthToken?: () => Promise<string>;
}

/**
 * Poll fred's status endpoint until the lease is ready or failed.
 *
 * Returns on `ready` or `failed` status.
 * On max attempts reached, returns the last status (caller decides next action).
 *
 * @param providerApiUrl - Fred's API base URL
 * @param leaseUuid - The lease UUID
 * @param authToken - ADR-036 auth token
 * @param opts - Polling options
 */
export async function pollLeaseUntilReady(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string,
  opts: PollOptions = {}
): Promise<FredLeaseStatus> {
  const intervalMs = opts.intervalMs ?? FRED_POLL_INTERVAL_MS;
  const maxAttempts = opts.maxAttempts ?? 60;

  let lastStatus: FredLeaseStatus = {
    state: LeaseState.LEASE_STATE_PENDING,
    phase: 'starting',
  };
  let consecutiveFailures = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.abortSignal?.aborted) {
      return lastStatus;
    }

    // Check chain state first — lease may be rejected/closed before fred knows
    if (opts.checkChainState) {
      try {
        const chainState = await opts.checkChainState();
        if (chainState) {
          const stateMap = CHAIN_STATE_MAP;
          lastStatus = {
            state: stateMap[chainState.state] ?? LeaseState.LEASE_STATE_CLOSED,
            phase: 'chain_rejected',
            last_error: `Lease ${chainState.state} on chain`,
          };
          opts.onProgress?.(lastStatus);
          return lastStatus;
        }
      } catch (error) {
        // Log but continue — chain check failure shouldn't stop polling
        logError('fred.pollLeaseUntilReady.checkChainState', error);
      }
    }

    try {
      const currentToken = opts.getAuthToken ? await opts.getAuthToken() : authToken;
      lastStatus = await getLeaseStatus(providerApiUrl, leaseUuid, currentToken);
      consecutiveFailures = 0;
      opts.onProgress?.(lastStatus);

      // Negative terminal states (closed/rejected/expired) — always stop
      if (TERMINAL_STATES.has(lastStatus.state)) {
        return lastStatus;
      }

      // Active + stable provision — stop (ready, failed, or no provision_status)
      if (lastStatus.state === LeaseState.LEASE_STATE_ACTIVE &&
          !TRANSIENT_PROVISION_STATES.has(lastStatus.provision_status ?? '')) {
        return lastStatus;
      }
    } catch (error) {
      consecutiveFailures++;
      logError('fred.pollLeaseUntilReady', error);
      // Surface persistent failures to the UI so the user isn't left wondering
      if (consecutiveFailures >= 3) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        opts.onProgress?.({
          ...lastStatus,
          phase: 'retrying',
          last_error: `Provider unreachable (${msg}), retrying...`,
        });
      }
    }

    // Wait before next attempt (unless last iteration)
    if (attempt < maxAttempts - 1) {
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(resolve, intervalMs);
        if (opts.abortSignal) {
          const onAbort = () => {
            clearTimeout(timeoutId);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (opts.abortSignal.aborted) {
            clearTimeout(timeoutId);
            resolve();
            return;
          }
          opts.abortSignal.addEventListener('abort', onAbort, { once: true });
        }
      }).catch(() => {
        // AbortError — return last status
        return;
      });
    }
  }

  logError('fred.pollLeaseUntilReady', new Error(`Polling exhausted after ${maxAttempts} attempts (last state: ${leaseStateToString(lastStatus.state)}, provision: ${lastStatus.provision_status ?? 'none'})`));
  return lastStatus;
}

// ============================================================================
// WebSocket — real-time lease status streaming
// ============================================================================

/**
 * WebSocket close codes that indicate permanent failure — reconnection is pointless.
 * 4001/4003 = custom auth failure codes from Fred; 1008 = policy violation (RFC 6455).
 */
const PERMANENT_WS_CLOSE_CODES = new Set([1008, 4001, 4003]);

export const FredWSEventSchema = z.object({
  lease_uuid: z.string(),
  status: z.string(),
  last_error: z.string().optional(),
  timestamp: z.string(),
});

export type FredWSEvent = z.infer<typeof FredWSEventSchema>;

/**
 * Build a WebSocket URL for Fred's events endpoint, routing through the
 * dev proxy when needed. The proxy upgrades the connection via `ws: true`.
 */
function buildFredWsUrl(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string
): string {
  const validatedUrl = validateProviderUrl(providerApiUrl);
  const baseUrl = normalizeBaseUrl(validatedUrl);
  const encodedLeaseUuid = encodeURIComponent(leaseUuid);
  const path = `/v1/leases/${encodedLeaseUuid}/events`;

  if (import.meta.env.DEV) {
    // Through the rsbuild dev proxy (ws: true handles WebSocket upgrade).
    // Auth is passed as a query param since WebSocket doesn't support custom headers.
    const wsBase = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
    return `${wsBase}/proxy-provider${path}?token=${encodeURIComponent(authToken)}&target=${encodeURIComponent(baseUrl)}`;
  }

  // Production: connect directly to Fred — use URL constructor to avoid injection
  const wsProtocol = validatedUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = new URL(`${wsProtocol}//${validatedUrl.host}${validatedUrl.pathname.replace(/\/$/, '')}${path}`);
  wsUrl.searchParams.set('token', authToken);
  return wsUrl.toString();
}

/**
 * Connect to Fred's lease events WebSocket endpoint.
 *
 * Returns a promise that resolves once the connection is open, yielding
 * a handle with an async event iterator and a close function.
 *
 * @throws {ProviderApiError} if the connection fails or is rejected
 */
export function connectLeaseEvents(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string,
  abortSignal?: AbortSignal
): Promise<{ events: AsyncGenerator<FredWSEvent>; close: () => void }> {
  const wsUrl = buildFredWsUrl(providerApiUrl, leaseUuid, authToken);

  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const ws = new WebSocket(wsUrl);
    const eventQueue: FredWSEvent[] = [];
    let resolveWaiter: (() => void) | null = null;
    let opened = false;
    let closed = false;
    let closeError: Error | undefined;

    const cleanup = () => {
      closed = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      // Wake up any pending iterator read
      resolveWaiter?.();
    };

    if (abortSignal) {
      abortSignal.addEventListener('abort', cleanup, { once: true });
    }

    ws.onopen = () => {
      opened = true;
      resolve({
        events: (async function* () {
          while (true) {
            if (eventQueue.length > 0) {
              yield eventQueue.shift()!;
              continue;
            }
            if (closed) {
              // Propagate permanent close errors so waitViaWS can detect them
              if (closeError) throw closeError;
              return;
            }
            // Wait for next message or close
            await new Promise<void>((r) => { resolveWaiter = r; });
            resolveWaiter = null;
          }
        })(),
        close: cleanup,
      });
    };

    ws.onmessage = (msg) => {
      try {
        const parsed: unknown = JSON.parse(msg.data);
        const result = FredWSEventSchema.safeParse(parsed);
        if (!result.success) {
          logError('fred.connectLeaseEvents: unexpected WS message shape', new Error(JSON.stringify(parsed).slice(0, 200)));
          return;
        }
        eventQueue.push(result.data);
        resolveWaiter?.();
      } catch (error) {
        logError('fred.connectLeaseEvents: invalid JSON in WS message', error);
      }
    };

    ws.onerror = () => {
      // onerror fires before onclose; stash a generic error for onclose to use
      closeError = new Error('WebSocket connection error');
    };

    ws.onclose = (event) => {
      closed = true;

      // Stash permanent close codes so the generator can throw them
      if (PERMANENT_WS_CLOSE_CODES.has(event.code)) {
        closeError = new ProviderApiError(event.code, `Fred WS closed: ${event.reason || 'auth/policy failure'}`);
      }

      resolveWaiter?.();

      // If we never opened, reject the connect promise
      if (!opened) {
        const detail = event.reason || closeError?.message || 'connection failed';
        reject(new ProviderApiError(event.code, `Fred WS error: ${detail}`));
      }
    };
  });
}

/**
 * Map a WS event to the existing FredLeaseStatus shape.
 *
 * WS events don't carry a chain-level lease state — only a provision status.
 * We default to ACTIVE, but chain-level terminal states (rejected, closed,
 * expired) are detected separately via `checkChainState` in the WS loop.
 */
function mapWSEventToStatus(event: FredWSEvent): FredLeaseStatus {
  return {
    state: LeaseState.LEASE_STATE_ACTIVE,
    provision_status: event.status,
    phase: event.status,
    last_error: event.last_error,
  };
}

export interface WaitForLeaseReadyOptions extends PollOptions {
  /** Skip WebSocket and go straight to polling. */
  disableWS?: boolean;
}

/**
 * Wait for a lease to reach a terminal state using WebSocket with polling fallback.
 *
 * Tries WebSocket first via Fred's `/v1/leases/{uuid}/events` endpoint.
 * Falls back to polling if:
 *   - WebSocket connection fails (e.g., 501 broker not enabled)
 *   - Caller sets `disableWS: true`
 *
 * On abort (signal), propagates immediately with no fallback.
 */
export async function waitForLeaseReady(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string,
  opts: WaitForLeaseReadyOptions = {}
): Promise<FredLeaseStatus> {
  if (opts.disableWS) {
    return pollLeaseUntilReady(providerApiUrl, leaseUuid, authToken, opts);
  }

  try {
    return await waitViaWS(providerApiUrl, leaseUuid, authToken, opts);
  } catch (error) {
    // Abort — propagate immediately, no fallback
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { state: LeaseState.LEASE_STATE_PENDING, phase: 'aborted' };
    }
    if (opts.abortSignal?.aborted) {
      return { state: LeaseState.LEASE_STATE_PENDING, phase: 'aborted' };
    }

    // WS unavailable — fall back to polling.
    logError('fred.waitForLeaseReady: WS failed, falling back to polling', error);

    return pollLeaseUntilReady(providerApiUrl, leaseUuid, authToken, opts);
  }
}

/**
 * Internal: wait for lease readiness via WebSocket with reconnection support.
 *
 * Reconnects up to WS_MAX_RECONNECT_ATTEMPTS times on connection drops.
 * Mints a fresh auth token before each connection (tokens have 30s TTL).
 * Respects the overall timeout derived from maxAttempts * intervalMs.
 */
async function waitViaWS(
  providerApiUrl: string,
  leaseUuid: string,
  _authToken: string,
  opts: WaitForLeaseReadyOptions
): Promise<FredLeaseStatus> {
  const intervalMs = opts.intervalMs ?? FRED_POLL_INTERVAL_MS;
  const maxAttempts = opts.maxAttempts ?? 60;
  const overallTimeoutMs = maxAttempts * intervalMs;
  const deadline = Date.now() + overallTimeoutMs;

  let lastStatus: FredLeaseStatus = {
    state: LeaseState.LEASE_STATE_PENDING,
    phase: 'connecting',
  };
  let everConnected = false;

  for (let attempt = 0; attempt < WS_MAX_RECONNECT_ATTEMPTS; attempt++) {
    if (opts.abortSignal?.aborted) return lastStatus;
    if (Date.now() >= deadline) break;

    // Check chain state before connecting
    if (opts.checkChainState) {
      try {
        const chainState = await opts.checkChainState();
        if (chainState) {
          const stateMap = CHAIN_STATE_MAP;
          lastStatus = {
            state: stateMap[chainState.state] ?? LeaseState.LEASE_STATE_CLOSED,
            phase: 'chain_rejected',
            last_error: `Lease ${chainState.state} on chain`,
          };
          opts.onProgress?.(lastStatus);
          return lastStatus;
        }
      } catch (error) {
        logError('fred.waitViaWS.checkChainState', error);
      }
    }

    // Mint fresh token for this connection
    const token = opts.getAuthToken ? await opts.getAuthToken() : _authToken;

    let conn: { events: AsyncGenerator<FredWSEvent>; close: () => void } | undefined;
    try {
      conn = await connectLeaseEvents(
        providerApiUrl,
        leaseUuid,
        token,
        opts.abortSignal
      );
      everConnected = true;

      // Liveness timeout: triggers reconnection if no data events arrive
      // within the window. Fred sends WebSocket ping frames every 30s which
      // keep the connection alive at the protocol level, but this timer
      // tracks application-level data liveness.
      let livenessTimer: ReturnType<typeof setTimeout> | undefined;
      const resetLiveness = () => {
        if (livenessTimer) clearTimeout(livenessTimer);
        livenessTimer = setTimeout(() => {
          conn?.close();
        }, WS_LIVENESS_TIMEOUT_MS);
      };

      resetLiveness();

      // Periodic chain-state check: catches on-chain rejections that
      // Fred may never surface as a WS event (e.g. manifest validation
      // failures where the lease is rejected before provisioning starts).
      // When terminal, we persist the status and set a flag so the main
      // loop returns it directly after conn.close() breaks the stream.
      let chainTerminalDetected = false;
      let chainPollTimer: ReturnType<typeof setInterval> | undefined;
      if (opts.checkChainState) {
        chainPollTimer = setInterval(async () => {
          try {
            const chainState = await opts.checkChainState!();
            if (chainState) {
              const stateMap = CHAIN_STATE_MAP;
              lastStatus = {
                state: stateMap[chainState.state] ?? LeaseState.LEASE_STATE_CLOSED,
                phase: 'chain_rejected',
                last_error: `Lease ${chainState.state} on chain`,
              };
              chainTerminalDetected = true;
              conn?.close();
            }
          } catch { /* next interval retries */ }
        }, intervalMs);
      }

      try {
        for await (const event of conn.events) {
          if (opts.abortSignal?.aborted) {
            if (livenessTimer) clearTimeout(livenessTimer);
            conn.close();
            return lastStatus;
          }
          if (Date.now() >= deadline) {
            if (livenessTimer) clearTimeout(livenessTimer);
            break;
          }

          resetLiveness();

          const status = mapWSEventToStatus(event);
          lastStatus = status;
          opts.onProgress?.(status);

          // Terminal chain states (defence-in-depth)
          if (TERMINAL_STATES.has(status.state)) {
            if (livenessTimer) clearTimeout(livenessTimer);
            conn.close();
            return status;
          }

          // Active + non-transient provision = done (ready, failed, etc.)
          if (
            status.state === LeaseState.LEASE_STATE_ACTIVE &&
            !TRANSIENT_PROVISION_STATES.has(status.provision_status ?? '')
          ) {
            // Final chain state verification: WS events always report ACTIVE
            // (mapWSEventToStatus hardcodes it), so verify the lease hasn't
            // been rejected/closed on chain before declaring success.
            if (opts.checkChainState) {
              try {
                const chainState = await opts.checkChainState();
                if (chainState) {
                  const stateMap = CHAIN_STATE_MAP;
                  const terminalStatus: FredLeaseStatus = {
                    state: stateMap[chainState.state] ?? LeaseState.LEASE_STATE_CLOSED,
                    provision_status: 'failed',
                    phase: 'chain_rejected',
                    last_error: `Lease ${chainState.state} on chain`,
                  };
                  if (livenessTimer) clearTimeout(livenessTimer);
                  conn.close();
                  opts.onProgress?.(terminalStatus);
                  return terminalStatus;
                }
              } catch (error) {
                logError('fred.waitViaWS.finalChainCheck', error);
              }
            }

            if (livenessTimer) clearTimeout(livenessTimer);
            conn.close();
            return status;
          }
        }

        // Stream ended normally
        if (livenessTimer) clearTimeout(livenessTimer);
        conn.close();
      } catch (error) {
        if (livenessTimer) clearTimeout(livenessTimer);
        conn.close();

        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (opts.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

        // Permanent close codes (auth failure, policy violation) — don't retry
        if (error instanceof ProviderApiError && PERMANENT_WS_CLOSE_CODES.has(error.status)) throw error;

        logError(`fred.waitViaWS: connection dropped (attempt ${attempt + 1})`, error);
      } finally {
        if (chainPollTimer) clearInterval(chainPollTimer);
        if (livenessTimer) clearTimeout(livenessTimer);
      }

      // Chain poll timer detected a terminal state — return directly
      // instead of continuing to the next reconnect attempt.
      if (chainTerminalDetected) {
        opts.onProgress?.(lastStatus);
        return lastStatus;
      }
    } catch (error) {
      conn?.close();

      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      if (opts.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

      // Permanent close codes — don't retry
      if (error instanceof ProviderApiError && PERMANENT_WS_CLOSE_CODES.has(error.status)) throw error;

      // Never connected — WS is unavailable. Fall back to polling immediately.
      if (!everConnected) throw error;

      logError(`fred.waitViaWS: reconnect failed (attempt ${attempt + 1})`, error);
    }

    // Wait before reconnecting
    if (attempt < WS_MAX_RECONNECT_ATTEMPTS - 1 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, WS_RECONNECT_DELAY_MS));
    }
  }

  throw new Error('WebSocket reconnect attempts exhausted');
}

/**
 * Fetch container logs for a lease from the provider.
 *
 * @param providerApiUrl - The provider's API base URL
 * @param leaseUuid - The lease UUID
 * @param authToken - Base64-encoded ADR-036 auth token
 * @param tail - Number of log lines to return (default 100)
 */
export async function getLeaseLogs(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string,
  tail = 100
): Promise<LeaseLogsResponse> {
  const encodedLeaseUuid = encodeURIComponent(leaseUuid);
  const { url, headers } = buildValidatedProviderRequest(
    providerApiUrl,
    `/v1/leases/${encodedLeaseUuid}/logs?tail=${tail}`,
    { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' }
  );

  const response = await fetch(url, { method: 'GET', headers });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new ProviderApiError(
      response.status,
      `Fred logs error (${response.status}): ${errorText}`
    );
  }

  try {
    const data = await response.json();
    return LeaseLogsResponseSchema.parse(data);
  } catch (error) {
    if (error instanceof ProviderApiError) throw error;
    throw new ProviderApiError(response.status, 'Fred returned invalid JSON for logs');
  }
}

/**
 * Fetch provision status for a lease from the provider.
 *
 * @param providerApiUrl - The provider's API base URL
 * @param leaseUuid - The lease UUID
 * @param authToken - Base64-encoded ADR-036 auth token
 */
export async function getLeaseProvision(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string
): Promise<LeaseProvision> {
  const encodedLeaseUuid = encodeURIComponent(leaseUuid);
  const { url, headers } = buildValidatedProviderRequest(
    providerApiUrl,
    `/v1/leases/${encodedLeaseUuid}/provision`,
    { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' }
  );

  const response = await fetch(url, { method: 'GET', headers });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new ProviderApiError(
      response.status,
      `Fred provision error (${response.status}): ${errorText}`
    );
  }

  try {
    const data = await response.json();
    return LeaseProvisionSchema.parse(data);
  } catch (error) {
    if (error instanceof ProviderApiError) throw error;
    throw new ProviderApiError(response.status, 'Fred returned invalid JSON for provision');
  }
}

export const LeaseReleaseSchema = z.object({
  version: z.number(),
  image: z.string(),
  status: z.string(),
  created_at: z.string(),
  error: z.string().optional(),
  manifest: z.string().optional(),
});

export type LeaseRelease = z.infer<typeof LeaseReleaseSchema>;

export const LeaseReleasesResponseSchema = z.object({
  lease_uuid: z.string(),
  tenant: z.string(),
  provider_uuid: z.string(),
  releases: z.array(LeaseReleaseSchema),
});

export type LeaseReleasesResponse = z.infer<typeof LeaseReleasesResponseSchema>;

const StatusResponseSchema = z.object({
  status: z.string(),
});

/**
 * Restart a running lease.
 *
 * @param providerApiUrl - The provider's API base URL
 * @param leaseUuid - The lease UUID
 * @param authToken - Base64-encoded ADR-036 auth token
 */
export async function restartLease(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string
): Promise<{ status: string }> {
  const encodedLeaseUuid = encodeURIComponent(leaseUuid);
  const { url, headers } = buildValidatedProviderRequest(
    providerApiUrl,
    `/v1/leases/${encodedLeaseUuid}/restart`,
    { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' }
  );

  const response = await fetch(url, { method: 'POST', headers });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new ProviderApiError(
      response.status,
      `Fred restart error (${response.status}): ${errorText}`
    );
  }

  try {
    const data = await response.json();
    return StatusResponseSchema.parse(data);
  } catch (error) {
    if (error instanceof ProviderApiError) throw error;
    throw new ProviderApiError(response.status, 'Fred returned invalid JSON for restart');
  }
}

/**
 * Update a running lease with a new manifest payload.
 *
 * @param providerApiUrl - The provider's API base URL
 * @param leaseUuid - The lease UUID
 * @param payload - Base64-encoded manifest content
 * @param authToken - Base64-encoded ADR-036 auth token
 */
export async function updateLease(
  providerApiUrl: string,
  leaseUuid: string,
  payload: string,
  authToken: string
): Promise<{ status: string }> {
  const encodedLeaseUuid = encodeURIComponent(leaseUuid);
  const { url, headers } = buildValidatedProviderRequest(
    providerApiUrl,
    `/v1/leases/${encodedLeaseUuid}/update`,
    { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' }
  );

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ payload }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new ProviderApiError(
      response.status,
      `Fred update error (${response.status}): ${errorText}`
    );
  }

  try {
    const data = await response.json();
    return StatusResponseSchema.parse(data);
  } catch (error) {
    if (error instanceof ProviderApiError) throw error;
    throw new ProviderApiError(response.status, 'Fred returned invalid JSON for update');
  }
}

/**
 * Fetch release history for a lease from the provider.
 *
 * @param providerApiUrl - The provider's API base URL
 * @param leaseUuid - The lease UUID
 * @param authToken - Base64-encoded ADR-036 auth token
 */
export async function getLeaseReleases(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string
): Promise<LeaseReleasesResponse> {
  const encodedLeaseUuid = encodeURIComponent(leaseUuid);
  const { url, headers } = buildValidatedProviderRequest(
    providerApiUrl,
    `/v1/leases/${encodedLeaseUuid}/releases`,
    { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' }
  );

  const response = await fetch(url, { method: 'GET', headers });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new ProviderApiError(
      response.status,
      `Fred releases error (${response.status}): ${errorText}`
    );
  }

  try {
    const data = await response.json();
    return LeaseReleasesResponseSchema.parse(data);
  } catch (error) {
    if (error instanceof ProviderApiError) throw error;
    throw new ProviderApiError(response.status, 'Fred returned invalid JSON for releases');
  }
}

export async function getLeaseInfo(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string
): Promise<LeaseInfo> {
  const encodedLeaseUuid = encodeURIComponent(leaseUuid);
  const { url, headers } = buildValidatedProviderRequest(
    providerApiUrl,
    `/v1/leases/${encodedLeaseUuid}/info`,
    { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' }
  );

  const response = await fetch(url, { method: 'GET', headers });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new ProviderApiError(
      response.status,
      `Fred info error (${response.status}): ${errorText}`
    );
  }

  try {
    const data = await response.json();
    return LeaseInfoSchema.parse(data);
  } catch (error) {
    if (error instanceof ProviderApiError) throw error;
    throw new ProviderApiError(response.status, 'Fred returned invalid JSON for info');
  }
}
