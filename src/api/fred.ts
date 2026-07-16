/**
 * Fred API client — thin HTTP wrappers over the SDK deploy facade.
 *
 * The wrappers below delegate to `@manifest-network/manifest-sdk/deploy` (which
 * re-exports mono-fred verbatim — identical fns + signatures) with Barney's
 * CORS-proxy/SSRF fetch adapter (`providerFetch`) and the DEV `allowLoopback`
 * flag injected. Use `getLeaseLogs`, never `getAppLogs` — the latter's
 * 4000-char cap would clip the full-logs LogCard.
 *
 * ENG-312 Phase 6: the browser WebSocket live-status path moved to the SDK's
 * `waitForLeaseStatus` + an injected `browserEventTransport`
 * (`src/api/eventTransport.ts`), so the hand-rolled polling loop + WS state
 * machine that used to live here are gone.
 */

import {
  getLeaseLogs as fredGetLeaseLogs,
  getLeaseProvision as fredGetLeaseProvision,
  getLeaseReleases as fredGetLeaseReleases,
  restartLease as fredRestartLease,
  updateLease as fredUpdateLease,
  type FredLeaseLogs,
  type FredLeaseProvision,
  type FredActionResponse,
  type FredLeaseReleases,
} from '@manifest-network/manifest-sdk/deploy';
import { providerFetch } from './providerFetchAdapter';

// Re-export types and classes from the SDK facade for backward compatibility
export {
  ProviderApiError,
  type FredLeaseStatus,
} from '@manifest-network/manifest-sdk/deploy';

// ============================================================================
// HTTP function wrappers — delegate to mono with providerFetch injected
// ============================================================================

// 0.18+ (ENG-490): every fred HTTP fn gained a trailing `allowLoopback=false` arg.
// In DEV the provider URL is localhost; without allowLoopback the SDK's internal
// validateProviderUrl throws (non-HTTPS/loopback) before providerFetch or the dev
// CORS proxy is ever reached. The dev /proxy-provider tunnel still routes the real
// request — this only relaxes the SDK's own URL guard.
const ALLOW_LOOPBACK = import.meta.env.DEV;

export function getLeaseLogs(
  providerApiUrl: string, leaseUuid: string, authToken: string, tail = 100
): Promise<FredLeaseLogs> {
  return fredGetLeaseLogs(providerApiUrl, leaseUuid, authToken, tail, providerFetch, ALLOW_LOOPBACK);
}

export function getLeaseProvision(
  providerApiUrl: string, leaseUuid: string, authToken: string
): Promise<FredLeaseProvision> {
  return fredGetLeaseProvision(providerApiUrl, leaseUuid, authToken, providerFetch, ALLOW_LOOPBACK);
}

export function getLeaseReleases(
  providerApiUrl: string, leaseUuid: string, authToken: string
): Promise<FredLeaseReleases> {
  return fredGetLeaseReleases(providerApiUrl, leaseUuid, authToken, providerFetch, ALLOW_LOOPBACK);
}

export function restartLease(
  providerApiUrl: string, leaseUuid: string, authToken: string
): Promise<FredActionResponse> {
  return fredRestartLease(providerApiUrl, leaseUuid, authToken, providerFetch, ALLOW_LOOPBACK);
}

export function updateLease(
  providerApiUrl: string, leaseUuid: string, payload: Uint8Array, authToken: string
): Promise<FredActionResponse> {
  return fredUpdateLease(providerApiUrl, leaseUuid, payload, authToken, providerFetch, ALLOW_LOOPBACK);
}
