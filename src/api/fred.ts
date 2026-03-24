/**
 * Fred API client — WebSocket streaming + polling for lease deployment status.
 *
 * HTTP functions (getLeaseStatus, getLeaseLogs, etc.) delegate to
 * @manifest-network/manifest-mcp-fred with Barney's CORS proxy/SSRF
 * fetch adapter injected automatically.
 *
 * Browser-specific code (WebSocket, CORS proxy) stays here.
 */

import { z } from 'zod';
import {
  getLeaseStatus as fredGetLeaseStatus,
  getLeaseLogs as fredGetLeaseLogs,
  getLeaseProvision as fredGetLeaseProvision,
  getLeaseReleases as fredGetLeaseReleases,
  getLeaseInfo as fredGetLeaseInfo,
  restartLease as fredRestartLease,
  updateLease as fredUpdateLease,
  ProviderApiError,
  type FredLeaseStatus,
  type FredLeaseLogs,
  type FredLeaseProvision,
  type FredActionResponse,
  type FredLeaseInfo,
} from '@manifest-network/manifest-mcp-fred';
import { providerFetch } from './providerFetchAdapter';
import { validateProviderUrl, normalizeBaseUrl } from './providerFetch';
import { LeaseState } from './billing';
import { logError } from '../utils/errors';
import {
  FRED_POLL_INTERVAL_MS,
  WS_RECONNECT_DELAY_MS,
  WS_MAX_RECONNECT_ATTEMPTS,
  WS_LIVENESS_TIMEOUT_MS,
} from '../config/constants';

// Re-export types and classes from mono for backward compatibility
export {
  ProviderApiError,
  MAX_TAIL,
  type FredLeaseStatus,
  type FredLeaseLogs,
  type FredLeaseProvision,
  type FredActionResponse,
  type FredLeaseInfo,
  type FredLeaseRelease,
  type FredLeaseReleases,
  type FredInstanceInfo,
  type FredServiceStatus,
} from '@manifest-network/manifest-mcp-fred';

// ============================================================================
// HTTP function wrappers — delegate to mono with providerFetch injected
// ============================================================================

export function getLeaseStatus(
  providerApiUrl: string, leaseUuid: string, authToken: string
): Promise<FredLeaseStatus> {
  return fredGetLeaseStatus(providerApiUrl, leaseUuid, authToken, providerFetch);
}

export function getLeaseLogs(
  providerApiUrl: string, leaseUuid: string, authToken: string, tail = 100
): Promise<FredLeaseLogs> {
  return fredGetLeaseLogs(providerApiUrl, leaseUuid, authToken, tail, providerFetch);
}

export function getLeaseProvision(
  providerApiUrl: string, leaseUuid: string, authToken: string
): Promise<FredLeaseProvision> {
  return fredGetLeaseProvision(providerApiUrl, leaseUuid, authToken, providerFetch);
}

export function getLeaseReleases(
  providerApiUrl: string, leaseUuid: string, authToken: string
) {
  return fredGetLeaseReleases(providerApiUrl, leaseUuid, authToken, providerFetch);
}

export function getLeaseInfo(
  providerApiUrl: string, leaseUuid: string, authToken: string
): Promise<FredLeaseInfo> {
  return fredGetLeaseInfo(providerApiUrl, leaseUuid, authToken, providerFetch);
}

export function restartLease(
  providerApiUrl: string, leaseUuid: string, authToken: string
): Promise<FredActionResponse> {
  return fredRestartLease(providerApiUrl, leaseUuid, authToken, providerFetch);
}

export function updateLease(
  providerApiUrl: string, leaseUuid: string, payload: Uint8Array, authToken: string
): Promise<FredActionResponse> {
  return fredUpdateLease(providerApiUrl, leaseUuid, payload, authToken, providerFetch);
}

// ============================================================================
// Polling — Barney-specific with checkChainState + maxAttempts
// ============================================================================

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

/** Chain lease states that indicate the lease is no longer viable */
export interface TerminalChainState {
  state: 'closed' | 'rejected' | 'expired';
}

export interface PollOptions {
  intervalMs?: number;
  maxAttempts?: number;
  onProgress?: (status: FredLeaseStatus) => void;
  abortSignal?: AbortSignal;
  checkChainState?: () => Promise<TerminalChainState | null>;
  getAuthToken?: () => Promise<string>;
}

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
          lastStatus = {
            state: CHAIN_STATE_MAP[chainState.state] ?? LeaseState.LEASE_STATE_CLOSED,
            phase: 'chain_rejected',
            last_error: `Lease ${chainState.state} on chain`,
          };
          opts.onProgress?.(lastStatus);
          return lastStatus;
        }
      } catch (error) {
        logError('fred.pollLeaseUntilReady.checkChainState', error);
      }
    }

    try {
      const currentToken = opts.getAuthToken ? await opts.getAuthToken() : authToken;
      lastStatus = await getLeaseStatus(providerApiUrl, leaseUuid, currentToken);
      consecutiveFailures = 0;
      opts.onProgress?.(lastStatus);

      if (TERMINAL_STATES.has(lastStatus.state)) {
        return lastStatus;
      }

      if (lastStatus.state === LeaseState.LEASE_STATE_ACTIVE &&
          !TRANSIENT_PROVISION_STATES.has(lastStatus.provision_status ?? '')) {
        return lastStatus;
      }
    } catch (error) {
      consecutiveFailures++;
      logError('fred.pollLeaseUntilReady', error);
      if (consecutiveFailures >= 3) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        opts.onProgress?.({
          ...lastStatus,
          phase: 'retrying',
          last_error: `Provider unreachable (${msg}), retrying...`,
        });
      }
    }

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

  logError('fred.pollLeaseUntilReady', new Error(`Polling exhausted after ${maxAttempts} attempts (state=${lastStatus.state}, phase=${lastStatus.phase ?? 'unknown'}, provision_status=${lastStatus.provision_status ?? 'unknown'})`));
  return lastStatus;
}

// ============================================================================
// WebSocket — real-time lease status streaming (browser-specific)
// ============================================================================

const PERMANENT_WS_CLOSE_CODES = new Set([1008, 4001, 4003]);

export const FredWSEventSchema = z.object({
  lease_uuid: z.string(),
  status: z.string(),
  last_error: z.string().optional(),
  timestamp: z.string(),
});

export type FredWSEvent = z.infer<typeof FredWSEventSchema>;

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
    const wsBase = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
    return `${wsBase}/proxy-provider${path}?token=${encodeURIComponent(authToken)}&target=${encodeURIComponent(baseUrl)}`;
  }

  const wsProtocol = validatedUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = new URL(`${wsProtocol}//${validatedUrl.host}${validatedUrl.pathname.replace(/\/$/, '')}${path}`);
  wsUrl.searchParams.set('token', authToken);
  return wsUrl.toString();
}

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
              if (closeError) throw closeError;
              return;
            }
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
      closeError = new Error('WebSocket connection error');
    };

    ws.onclose = (event) => {
      closed = true;
      if (PERMANENT_WS_CLOSE_CODES.has(event.code)) {
        closeError = new ProviderApiError(event.code, `Fred WS closed: ${event.reason || 'auth/policy failure'}`);
      }
      resolveWaiter?.();
      if (!opened) {
        const detail = event.reason || closeError?.message || 'connection failed';
        reject(new ProviderApiError(event.code, `Fred WS error: ${detail}`));
      }
    };
  });
}

function mapWSEventToStatus(event: FredWSEvent): FredLeaseStatus {
  return {
    state: LeaseState.LEASE_STATE_ACTIVE,
    provision_status: event.status,
    phase: event.status,
    last_error: event.last_error,
  };
}

export interface WaitForLeaseReadyOptions extends PollOptions {
  disableWS?: boolean;
}

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
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { state: LeaseState.LEASE_STATE_PENDING, phase: 'aborted' };
    }
    if (opts.abortSignal?.aborted) {
      return { state: LeaseState.LEASE_STATE_PENDING, phase: 'aborted' };
    }

    logError('fred.waitForLeaseReady: WS failed, falling back to polling', error);
    return pollLeaseUntilReady(providerApiUrl, leaseUuid, authToken, opts);
  }
}

async function waitViaWS(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string,
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

    if (opts.checkChainState) {
      try {
        const chainState = await opts.checkChainState();
        if (chainState) {
          lastStatus = {
            state: CHAIN_STATE_MAP[chainState.state] ?? LeaseState.LEASE_STATE_CLOSED,
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

    const token = opts.getAuthToken ? await opts.getAuthToken() : authToken;

    let conn: { events: AsyncGenerator<FredWSEvent>; close: () => void } | undefined;
    try {
      conn = await connectLeaseEvents(providerApiUrl, leaseUuid, token, opts.abortSignal);
      everConnected = true;

      try {
        const snapshot = await getLeaseStatus(providerApiUrl, leaseUuid, token);
        if (TERMINAL_STATES.has(snapshot.state)) {
          conn.close();
          opts.onProgress?.(snapshot);
          return snapshot;
        }
        if (snapshot.state === LeaseState.LEASE_STATE_ACTIVE &&
            !TRANSIENT_PROVISION_STATES.has(snapshot.provision_status ?? '')) {
          conn.close();
          opts.onProgress?.(snapshot);
          return snapshot;
        }
        lastStatus = snapshot;
        opts.onProgress?.(snapshot);
      } catch (error) {
        logError('fred.waitViaWS.subscribeCheck', error);
      }

      let livenessTimer: ReturnType<typeof setTimeout> | undefined;
      const resetLiveness = () => {
        if (livenessTimer) clearTimeout(livenessTimer);
        livenessTimer = setTimeout(() => {
          conn?.close();
        }, WS_LIVENESS_TIMEOUT_MS);
      };

      resetLiveness();

      let chainTerminalDetected = false;
      let chainPollTimer: ReturnType<typeof setInterval> | undefined;
      if (opts.checkChainState) {
        chainPollTimer = setInterval(async () => {
          try {
            const chainState = await opts.checkChainState!();
            if (chainState) {
              lastStatus = {
                state: CHAIN_STATE_MAP[chainState.state] ?? LeaseState.LEASE_STATE_CLOSED,
                phase: 'chain_rejected',
                last_error: `Lease ${chainState.state} on chain`,
              };
              chainTerminalDetected = true;
              conn?.close();
            }
          } catch (error) { logError('fred.waitViaWS.chainPollInterval', error); }
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

          if (TERMINAL_STATES.has(status.state)) {
            if (livenessTimer) clearTimeout(livenessTimer);
            conn.close();
            return status;
          }

          if (
            status.state === LeaseState.LEASE_STATE_ACTIVE &&
            !TRANSIENT_PROVISION_STATES.has(status.provision_status ?? '')
          ) {
            if (opts.checkChainState) {
              try {
                const chainState = await opts.checkChainState();
                if (chainState) {
                  const terminalStatus: FredLeaseStatus = {
                    state: CHAIN_STATE_MAP[chainState.state] ?? LeaseState.LEASE_STATE_CLOSED,
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

        if (livenessTimer) clearTimeout(livenessTimer);
        conn.close();
      } catch (error) {
        if (livenessTimer) clearTimeout(livenessTimer);
        conn.close();

        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (opts.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

        if (error instanceof ProviderApiError && PERMANENT_WS_CLOSE_CODES.has(error.status)) throw error;

        logError(`fred.waitViaWS: connection dropped (attempt ${attempt + 1})`, error);
      } finally {
        if (chainPollTimer) clearInterval(chainPollTimer);
        if (livenessTimer) clearTimeout(livenessTimer);
      }

      if (chainTerminalDetected) {
        opts.onProgress?.(lastStatus);
        return lastStatus;
      }
    } catch (error) {
      conn?.close();

      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      if (opts.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

      if (error instanceof ProviderApiError && PERMANENT_WS_CLOSE_CODES.has(error.status)) throw error;

      if (!everConnected) throw error;

      logError(`fred.waitViaWS: reconnect failed (attempt ${attempt + 1})`, error);
    }

    if (attempt < WS_MAX_RECONNECT_ATTEMPTS - 1 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, WS_RECONNECT_DELAY_MS));
    }
  }

  throw new Error('WebSocket reconnect attempts exhausted');
}
