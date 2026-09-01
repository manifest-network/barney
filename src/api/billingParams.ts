import { getBillingParams } from './billing';
import { withTimeout } from './utils';

let cached: Promise<string[]> | null = null;

/**
 * Read `Params.reservedDomainSuffixes` from the chain.
 * Cached for the session — invalidate on demand via `invalidateReservedDomainSuffixesCache`.
 * Suffixes are stored on chain with leading dots (e.g. `.barney0.manifest0.net`)
 * and the keeper also rejects matches against the apex form.
 *
 * Bounded with `withTimeout` (default `AI_TOOL_API_TIMEOUT_MS`) so a partial-
 * failure LCD (accepts TCP, stalls on /billing/params specifically) can't
 * pin the ConfirmationCard's Confirm button in `asyncDomainPending` forever.
 * On timeout: cache is cleared (existing `.catch`), error propagates to
 * `validateAll`'s outer catch, suffixes fall back to []; the chain serves
 * as the authoritative reservation check post-broadcast.
 * See PR #93 Copilot 3243993831.
 */
export async function getReservedDomainSuffixes(signal?: AbortSignal): Promise<string[]> {
  if (!cached) {
    cached = withTimeout(getBillingParams(), undefined, 'getBillingParams')
      .then((params) => params.reservedDomainSuffixes ?? [])
      .catch((err) => {
        cached = null;
        throw err;
      });
  }
  // The cached chain read remains shared, but each caller can stop awaiting it
  // immediately when its own workflow is cancelled.
  return signal
    ? withTimeout(cached, undefined, 'getReservedDomainSuffixes', signal)
    : cached;
}

export function invalidateReservedDomainSuffixesCache(): void {
  cached = null;
}
