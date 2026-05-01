import { getBillingParams } from './billing';

let cached: Promise<string[]> | null = null;

/**
 * Read `Params.reservedDomainSuffixes` from the chain.
 * Cached for the session — invalidate on demand via `invalidateReservedDomainSuffixesCache`.
 * Suffixes are stored on chain with leading dots (e.g. `.barney0.manifest0.net`)
 * and the keeper also rejects matches against the apex form.
 */
export async function getReservedDomainSuffixes(): Promise<string[]> {
  if (!cached) {
    cached = getBillingParams()
      .then((params) => params.reservedDomainSuffixes ?? [])
      .catch((err) => {
        cached = null;
        throw err;
      });
  }
  return cached;
}

export function invalidateReservedDomainSuffixesCache(): void {
  cached = null;
}
