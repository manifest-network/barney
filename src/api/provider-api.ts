/**
 * Provider API client — auth, health checks, connection info, payload upload.
 *
 * Most functions delegate to the @manifest-network/manifest-sdk/deploy facade with
 * Barney's CORS proxy/SSRF fetch adapter injected. Barney-specific code
 * (null-returning getProviderHealth) stays here.
 */

import {
  getProviderHealth as fredGetProviderHealth,
  getLeaseConnectionInfo as fredGetLeaseConnectionInfo,
  type ProviderHealthResponse,
  type LeaseConnectionResponse,
} from '@manifest-network/manifest-sdk/deploy';
import { providerFetch } from './providerFetchAdapter';
import { logError } from '../utils/errors';
import { HEALTH_CHECK_TIMEOUT_MS } from '../config/constants';

// Re-export types and classes from the SDK facade for backward compatibility
export {
  ProviderApiError,
  type ConnectionDetails,
} from '@manifest-network/manifest-sdk/deploy';

// ============================================================================
// Barney-specific functions
// ============================================================================

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
