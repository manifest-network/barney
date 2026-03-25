/**
 * Provider API client — auth, health checks, connection info, payload upload.
 *
 * Most functions delegate to @manifest-network/manifest-mcp-fred with Barney's
 * CORS proxy/SSRF fetch adapter injected. Barney-specific code (validateAuthTimestamp,
 * null-returning getProviderHealth) stays here.
 */

import {
  getProviderHealth as fredGetProviderHealth,
  getLeaseConnectionInfo as fredGetLeaseConnectionInfo,
  uploadLeaseData as fredUploadLeaseData,
  type ProviderHealthResponse,
  type LeaseConnectionResponse,
} from '@manifest-network/manifest-mcp-fred';
import { providerFetch } from './providerFetchAdapter';
import { logError } from '../utils/errors';
import { HEALTH_CHECK_TIMEOUT_MS } from '../config/constants';

// Re-export types and classes from mono for backward compatibility
export {
  createSignMessage,
  createLeaseDataSignMessage,
  createAuthToken,
  ProviderApiError,
  type LeaseConnectionResponse,
  type ConnectionDetails,
  type InstanceInfo,
  type ServiceConnectionDetails,
  type ProviderHealthResponse,
  type AuthTokenPayload,
} from '@manifest-network/manifest-mcp-fred';

// Re-export from utils/hash.ts for backward compatibility
export { sha256Hex as computePayloadHash } from '../utils/hash';
export { isValidMetaHash } from '../utils/hash';

// ============================================================================
// Barney-specific functions
// ============================================================================

const MAX_AUTH_TOKEN_AGE_SECONDS = 60;
const MAX_AUTH_TOKEN_FUTURE_SECONDS = 10;

/**
 * Validates that a timestamp is recent enough for auth token use.
 * Client-side freshness check — rejects stale or future timestamps.
 */
export function validateAuthTimestamp(timestamp: number): void {
  if (!Number.isFinite(timestamp)) {
    throw new Error('Auth timestamp must be a finite number');
  }

  const now = Math.floor(Date.now() / 1000);
  const age = now - timestamp;

  if (age > MAX_AUTH_TOKEN_AGE_SECONDS) {
    throw new Error(`Auth token expired: timestamp is ${age}s old (max ${MAX_AUTH_TOKEN_AGE_SECONDS}s)`);
  }

  if (age < -MAX_AUTH_TOKEN_FUTURE_SECONDS) {
    throw new Error(`Auth token timestamp is ${-age}s in the future (max ${MAX_AUTH_TOKEN_FUTURE_SECONDS}s)`);
  }
}

/**
 * Checks the health status of a provider's API.
 * Returns null if the provider is unreachable (Barney convention).
 * Wraps mono's throwing version with try/catch fallback.
 */
export async function getProviderHealth(
  providerApiUrl: string,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS
): Promise<ProviderHealthResponse | null> {
  if (!providerApiUrl) return null;

  try {
    return await fredGetProviderHealth(providerApiUrl, timeoutMs, providerFetch);
  } catch (error) {
    logError('provider-api.getProviderHealth', error);
    return null;
  }
}

/**
 * Fetches lease connection info from the provider's API.
 * Delegates to mono with CORS proxy/SSRF fetch adapter injected.
 */
export function getLeaseConnectionInfo(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string
): Promise<LeaseConnectionResponse> {
  return fredGetLeaseConnectionInfo(providerApiUrl, leaseUuid, authToken, providerFetch);
}

/**
 * Uploads lease payload data to the provider's API.
 * Delegates to mono with CORS proxy/SSRF fetch adapter injected.
 */
export function uploadLeaseData(
  providerApiUrl: string,
  leaseUuid: string,
  payload: Uint8Array,
  authToken: string
): Promise<void> {
  return fredUploadLeaseData(providerApiUrl, leaseUuid, payload, authToken, providerFetch);
}
