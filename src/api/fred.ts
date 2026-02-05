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
import { logError } from '../utils/errors';

export interface FredLeaseStatus {
  status: 'provisioning' | 'ready' | 'active' | 'failed';
  phase?: string;
  steps?: Record<string, string>;
  instances?: Array<{ name: string; status: string; ports?: Record<string, number> }>;
  endpoints?: Record<string, string>;
  error?: string;
  fail_count?: number;
  created_at?: string;
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
    return await response.json();
  } catch {
    throw new ProviderApiError(response.status, 'Fred returned invalid JSON');
  }
}

/** Chain lease states that indicate the lease is no longer viable */
export type TerminalChainState = 'closed' | 'rejected' | 'expired';

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
    status: 'provisioning',
    phase: 'starting',
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.abortSignal?.aborted) {
      return lastStatus;
    }

    // Check chain state first — lease may be rejected/closed before fred knows
    if (opts.checkChainState) {
      try {
        const chainState = await opts.checkChainState();
        if (chainState) {
          // Terminal chain state — return failed status
          lastStatus = {
            status: 'failed',
            phase: 'chain_rejected',
            error: `Lease ${chainState} on chain`,
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
      lastStatus = await getLeaseStatus(providerApiUrl, leaseUuid, authToken);
      opts.onProgress?.(lastStatus);

      // 'active' is an alias for 'ready' (fred may use either)
      if (lastStatus.status === 'ready' || lastStatus.status === 'active' || lastStatus.status === 'failed') {
        return lastStatus;
      }
    } catch (error) {
      // Log but continue polling — transient errors shouldn't abort the loop
      logError('fred.pollLeaseUntilReady', error);
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
