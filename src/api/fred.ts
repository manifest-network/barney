/**
 * Fred API client for polling lease deployment status.
 *
 * Fred is the provider-side service that manages container deployments.
 * Its `/status/{uuid}` endpoint returns deployment progress and readiness.
 *
 * Follows the same patterns as provider-api.ts:
 * - SSRF validation via parseHttpUrl + isUrlSsrfSafe
 * - Dev CORS proxy via buildProviderFetchArgs
 * - ADR-036 auth tokens
 * - ProviderApiError for typed HTTP failures
 */

import { parseHttpUrl, isUrlSsrfSafe } from '../utils/url';
import { ProviderApiError } from './provider-api';
import { LeaseState, leaseStateFromString } from './billing';
import { logError } from '../utils/errors';
import {
  FRED_POLL_INTERVAL_MS,
  SSE_RECONNECT_DELAY_MS,
  SSE_MAX_RECONNECT_ATTEMPTS,
  SSE_KEEPALIVE_TIMEOUT_MS,
} from '../config/constants';

export interface FredLeaseStatus {
  state: LeaseState;
  provision_status?: string;
  phase?: string;
  steps?: Record<string, string>;
  instances?: Array<{ name: string; status: string; ports?: Record<string, number> }>;
  endpoints?: Record<string, string>;
  error?: string;
  fail_count?: number;
  created_at?: string;
}

/** Negative terminal lease states — polling should always stop for these. */
const TERMINAL_STATES = new Set<LeaseState>([
  LeaseState.LEASE_STATE_CLOSED,
  LeaseState.LEASE_STATE_REJECTED,
  LeaseState.LEASE_STATE_EXPIRED,
]);

/** Provision states that indicate the backend is still working — keep polling. */
const TRANSIENT_PROVISION_STATES = new Set(['provisioning', 'updating', 'restarting']);

/**
 * Parse a raw fred response into a FredLeaseStatus.
 * Fred returns `state: 'LEASE_STATE_ACTIVE'` (chain-style enum string).
 */
function parseFredResponse(raw: Record<string, unknown>): FredLeaseStatus {
  let state = LeaseState.LEASE_STATE_PENDING;
  if (typeof raw.state === 'string' && raw.state) {
    try {
      const parsed = leaseStateFromString(raw.state);
      if (parsed !== LeaseState.UNRECOGNIZED) {
        state = parsed;
      }
    } catch (error) {
      logError(`fred.parseFredResponse: unrecognized state "${raw.state}"`, error);
    }
  }

  // Explicitly extract known fields to prevent injection of unexpected properties
  // from untrusted provider responses.
  const result: FredLeaseStatus = { state };
  if (typeof raw.provision_status === 'string') result.provision_status = raw.provision_status;
  if (typeof raw.phase === 'string') result.phase = raw.phase;
  if (raw.steps && typeof raw.steps === 'object' && !Array.isArray(raw.steps)) {
    result.steps = raw.steps as Record<string, string>;
  }
  if (Array.isArray(raw.instances)) result.instances = raw.instances as FredLeaseStatus['instances'];
  if (raw.endpoints && typeof raw.endpoints === 'object' && !Array.isArray(raw.endpoints)) {
    result.endpoints = raw.endpoints as Record<string, string>;
  }
  if (typeof raw.error === 'string') result.error = raw.error;
  if (typeof raw.fail_count === 'number') result.fail_count = raw.fail_count;
  if (typeof raw.created_at === 'string') result.created_at = raw.created_at;
  return result;
}

/**
 * Validates and normalizes a provider API URL.
 * Prevents SSRF by blocking private/internal addresses (except localhost in dev).
 */
function validateProviderUrl(url: string): URL {
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    throw new Error(`Invalid provider API URL: ${url || '(empty)'}`);
  }
  if (!isUrlSsrfSafe(parsed)) {
    throw new Error('Provider API URL cannot point to private/internal addresses');
  }
  return parsed;
}

function normalizeBaseUrl(validated: URL): string {
  return validated.origin + validated.pathname.replace(/\/$/, '');
}

/**
 * Build fetch URL and headers, routing through dev CORS proxy when needed.
 */
function buildFredFetchArgs(
  baseUrl: string,
  path: string,
  extraHeaders?: Record<string, string>
): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...extraHeaders };

  if (import.meta.env.DEV) {
    headers['X-Proxy-Target'] = baseUrl;
    return { url: `/proxy-provider${path}`, headers };
  }

  return { url: `${baseUrl}${path}`, headers };
}

/**
 * Validate, normalize, and build fetch args in one step.
 */
function buildValidatedFredRequest(
  providerApiUrl: string,
  path: string,
  extraHeaders?: Record<string, string>
): { url: string; headers: Record<string, string> } {
  const validatedUrl = validateProviderUrl(providerApiUrl);
  const baseUrl = normalizeBaseUrl(validatedUrl);
  return buildFredFetchArgs(baseUrl, path, extraHeaders);
}

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
  const { url, headers } = buildValidatedFredRequest(
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
    return parseFredResponse(raw);
  } catch {
    throw new ProviderApiError(response.status, 'Fred returned invalid JSON');
  }
}

/** Chain lease states that indicate the lease is no longer viable */
export interface TerminalChainState {
  state: 'closed' | 'rejected' | 'expired';
}

/** Response from the logs endpoint. */
export interface LeaseLogsResponse {
  lease_uuid: string;
  tenant: string;
  provider_uuid: string;
  /** Container logs keyed by service/container name. */
  logs: Record<string, string>;
}

/** Provision status from the provider. */
export interface LeaseProvision {
  status: string;
  fail_count: number;
  last_error: string;
}

/** Connection details from the provider. */
export interface LeaseInfo {
  host: string;
  ports?: Record<string, unknown>;
}

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
  const intervalMs = opts.intervalMs ?? 3000;
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
          const stateMap: Record<string, LeaseState> = {
            closed: LeaseState.LEASE_STATE_CLOSED,
            rejected: LeaseState.LEASE_STATE_REJECTED,
            expired: LeaseState.LEASE_STATE_EXPIRED,
          };
          lastStatus = {
            state: stateMap[chainState.state] ?? LeaseState.LEASE_STATE_CLOSED,
            phase: 'chain_rejected',
            error: `Lease ${chainState.state} on chain`,
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
          error: `Provider unreachable (${msg}), retrying...`,
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

  return lastStatus;
}

// ============================================================================
// SSE (Server-Sent Events) — real-time lease status streaming
// ============================================================================

/** Wire format for SSE events from Fred's /v1/leases/{uuid}/events endpoint. */
export interface FredSSEEvent {
  lease_uuid: string;
  status: string; // 'provisioning' | 'ready' | 'failed' | 'restarting' | 'updating'
  error?: string;
  timestamp: string; // RFC3339
}

/** Handle returned by subscribeLeaseEvents. */
export interface SSESubscription {
  events: AsyncGenerator<FredSSEEvent>;
  close: () => void;
}

/**
 * Parse a ReadableStream of SSE frames into typed events.
 *
 * SSE protocol: events are delimited by `\n\n`. Each event has lines like:
 *   `data: {"lease_uuid":"...","status":"ready"}`
 * Lines starting with `:` are comments (keepalives) and are ignored.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal
): AsyncGenerator<FredSSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (abortSignal?.aborted) return;

      const { done, value } = await reader.read();
      if (done) return;

      buffer += decoder.decode(value, { stream: true });

      // Process complete events (delimited by double newline)
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        // Extract data lines, skip comments (: prefix) and other fields
        const lines = frame.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            try {
              const event: FredSSEEvent = JSON.parse(jsonStr);
              yield event;
            } catch (error) {
              logError('fred.parseSSEStream: invalid JSON in SSE data', error);
            }
          }
          // Lines starting with ':' are comments (keepalives) — skip
          // Other field types (event:, id:, retry:) are ignored
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Subscribe to real-time lease events via SSE.
 *
 * Uses fetch() + ReadableStream instead of EventSource because the latter
 * does not support custom Authorization headers.
 *
 * @throws {ProviderApiError} on non-200 responses (501 = SSE not enabled)
 */
export async function subscribeLeaseEvents(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string,
  abortSignal?: AbortSignal
): Promise<SSESubscription> {
  const encodedLeaseUuid = encodeURIComponent(leaseUuid);
  const { url, headers } = buildValidatedFredRequest(
    providerApiUrl,
    `/v1/leases/${encodedLeaseUuid}/events`,
    { Authorization: `Bearer ${authToken}`, Accept: 'text/event-stream' }
  );

  // Link caller's signal to an internal controller so close() also aborts
  const controller = new AbortController();
  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort();
    } else {
      abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: controller.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new ProviderApiError(
      response.status,
      `Fred SSE error (${response.status}): ${errorText}`
    );
  }

  if (!response.body) {
    throw new ProviderApiError(0, 'Fred SSE response has no body');
  }

  return {
    events: parseSSEStream(response.body, controller.signal),
    close: () => controller.abort(),
  };
}

/**
 * Map an SSE event to the existing FredLeaseStatus shape.
 * This lets callers see identical data regardless of SSE vs polling.
 *
 * State is always ACTIVE because Fred's SSE endpoint only emits events for
 * leases the provider is actively managing. Chain-level terminal states
 * (closed/rejected/expired) are detected separately via `checkChainState`.
 */
function mapSSEEventToStatus(event: FredSSEEvent): FredLeaseStatus {
  return {
    state: LeaseState.LEASE_STATE_ACTIVE,
    provision_status: event.status,
    phase: event.status,
    error: event.error,
  };
}

export interface WaitForLeaseReadyOptions extends PollOptions {
  /** Skip SSE and go straight to polling. */
  disableSSE?: boolean;
}

/**
 * Wait for a lease to reach a terminal state using SSE with polling fallback.
 *
 * Tries SSE first via Fred's `/v1/leases/{uuid}/events` endpoint.
 * Falls back to polling if:
 *   - Fred returns 501 (broker not enabled)
 *   - SSE connection fails for other reasons
 *   - Caller sets `disableSSE: true`
 *
 * On abort (signal), propagates immediately with no fallback.
 */
export async function waitForLeaseReady(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string,
  opts: WaitForLeaseReadyOptions = {}
): Promise<FredLeaseStatus> {
  // Skip SSE if explicitly disabled
  if (opts.disableSSE) {
    return pollLeaseUntilReady(providerApiUrl, leaseUuid, authToken, opts);
  }

  try {
    return await waitViaSSE(providerApiUrl, leaseUuid, authToken, opts);
  } catch (error) {
    // Abort — propagate immediately, no fallback
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { state: LeaseState.LEASE_STATE_PENDING, phase: 'aborted' };
    }
    if (opts.abortSignal?.aborted) {
      return { state: LeaseState.LEASE_STATE_PENDING, phase: 'aborted' };
    }

    // 501 = SSE not enabled (broker nil) — expected fallback
    if (error instanceof ProviderApiError && error.status === 501) {
      logError('fred.waitForLeaseReady: SSE not available (501), falling back to polling', error);
    } else {
      logError('fred.waitForLeaseReady: SSE failed, falling back to polling', error);
    }

    return pollLeaseUntilReady(providerApiUrl, leaseUuid, authToken, opts);
  }
}

/**
 * Internal: wait for lease readiness via SSE with reconnection support.
 *
 * Reconnects up to SSE_MAX_RECONNECT_ATTEMPTS times on connection drops.
 * Mints a fresh auth token before each connection (tokens have 30s TTL).
 * Respects the overall timeout derived from maxAttempts * intervalMs.
 */
async function waitViaSSE(
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

  for (let attempt = 0; attempt < SSE_MAX_RECONNECT_ATTEMPTS; attempt++) {
    if (opts.abortSignal?.aborted) return lastStatus;
    if (Date.now() >= deadline) break;

    // Check chain state before connecting
    if (opts.checkChainState) {
      try {
        const chainState = await opts.checkChainState();
        if (chainState) {
          const stateMap: Record<string, LeaseState> = {
            closed: LeaseState.LEASE_STATE_CLOSED,
            rejected: LeaseState.LEASE_STATE_REJECTED,
            expired: LeaseState.LEASE_STATE_EXPIRED,
          };
          lastStatus = {
            state: stateMap[chainState.state] ?? LeaseState.LEASE_STATE_CLOSED,
            phase: 'chain_rejected',
            error: `Lease ${chainState.state} on chain`,
          };
          opts.onProgress?.(lastStatus);
          return lastStatus;
        }
      } catch (error) {
        logError('fred.waitViaSSE.checkChainState', error);
      }
    }

    // Mint fresh token for this connection
    const token = opts.getAuthToken ? await opts.getAuthToken() : _authToken;

    let subscription: SSESubscription | undefined;
    try {
      subscription = await subscribeLeaseEvents(
        providerApiUrl,
        leaseUuid,
        token,
        opts.abortSignal
      );

      // Keepalive timeout: triggers reconnection if no *data events* arrive
      // within the window. Note: SSE keepalive comments (`: keepalive\n\n`)
      // are consumed by parseSSEStream but don't yield events, so this timer
      // tracks data liveness, not connection liveness. If provisioning goes
      // quiet for >45s with only keepalives, we'll reconnect and eventually
      // fall back to polling — acceptable since polling handles long provisions.
      let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
      const resetKeepalive = () => {
        if (keepaliveTimer) clearTimeout(keepaliveTimer);
        keepaliveTimer = setTimeout(() => {
          subscription?.close();
        }, SSE_KEEPALIVE_TIMEOUT_MS);
      };

      resetKeepalive();

      try {
        for await (const event of subscription.events) {
          if (opts.abortSignal?.aborted) {
            if (keepaliveTimer) clearTimeout(keepaliveTimer);
            subscription.close();
            return lastStatus;
          }
          if (Date.now() >= deadline) {
            if (keepaliveTimer) clearTimeout(keepaliveTimer);
            break;
          }

          resetKeepalive();

          const status = mapSSEEventToStatus(event);
          lastStatus = status;
          opts.onProgress?.(status);

          // Terminal chain states (defence-in-depth — SSE events currently
          // only fire for active leases, so this won't match today, but
          // guards against future Fred changes)
          if (TERMINAL_STATES.has(status.state)) {
            if (keepaliveTimer) clearTimeout(keepaliveTimer);
            subscription.close();
            return status;
          }

          // Active + non-transient provision = done (ready, failed, etc.)
          // Caller inspects provision_status to distinguish success/failure.
          if (
            status.state === LeaseState.LEASE_STATE_ACTIVE &&
            !TRANSIENT_PROVISION_STATES.has(status.provision_status ?? '')
          ) {
            if (keepaliveTimer) clearTimeout(keepaliveTimer);
            subscription.close();
            return status;
          }
        }

        // Stream ended normally — close and break out of reconnect loop
        if (keepaliveTimer) clearTimeout(keepaliveTimer);
        subscription.close();
      } catch (error) {
        if (keepaliveTimer) clearTimeout(keepaliveTimer);
        subscription.close();

        // Abort — rethrow to let caller propagate
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (opts.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

        logError(`fred.waitViaSSE: connection dropped (attempt ${attempt + 1})`, error);
      }
    } catch (error) {
      // subscribeLeaseEvents threw — could be 501, network error, etc.
      subscription?.close();
      throw error;
    }

    // Wait before reconnecting
    if (attempt < SSE_MAX_RECONNECT_ATTEMPTS - 1 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, SSE_RECONNECT_DELAY_MS));
    }
  }

  // Exhausted reconnect attempts — throw so waitForLeaseReady falls back to polling
  throw new Error('SSE reconnect attempts exhausted');
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
  const { url, headers } = buildValidatedFredRequest(
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
    return await response.json();
  } catch {
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
  const { url, headers } = buildValidatedFredRequest(
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
    return await response.json();
  } catch {
    throw new ProviderApiError(response.status, 'Fred returned invalid JSON for provision');
  }
}

/**
 * Fetch connection details (host, ports) for a lease from the provider.
 *
 * @param providerApiUrl - The provider's API base URL
 * @param leaseUuid - The lease UUID
 * @param authToken - Base64-encoded ADR-036 auth token
 */
/** A single release/version entry for a lease. */
export interface LeaseRelease {
  version: number;
  image: string;
  status: string;
  created_at: string;
  error?: string;
  manifest?: string;
}

/** Response from the releases endpoint. */
export interface LeaseReleasesResponse {
  lease_uuid: string;
  tenant: string;
  provider_uuid: string;
  releases: LeaseRelease[];
}

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
  const { url, headers } = buildValidatedFredRequest(
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
    return await response.json();
  } catch {
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
  const { url, headers } = buildValidatedFredRequest(
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
    return await response.json();
  } catch {
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
  const { url, headers } = buildValidatedFredRequest(
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
    return await response.json();
  } catch {
    throw new ProviderApiError(response.status, 'Fred returned invalid JSON for releases');
  }
}

export async function getLeaseInfo(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string
): Promise<LeaseInfo> {
  const encodedLeaseUuid = encodeURIComponent(leaseUuid);
  const { url, headers } = buildValidatedFredRequest(
    providerApiUrl,
    `/info/${encodedLeaseUuid}`,
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
    return await response.json();
  } catch {
    throw new ProviderApiError(response.status, 'Fred returned invalid JSON for info');
  }
}
