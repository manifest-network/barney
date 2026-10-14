import { canonicalProviderUrl } from './providerUrl';
import { runtimeConfig } from './runtimeConfig';

/**
 * ENG-1457: `PUBLIC_PROVIDER_ALLOWLIST` limits this deployment to the listed
 * provider `api_url`s. Providers outside it are treated as nonexistent: they
 * are absent from the catalog and deploy paths, and the app registry hides
 * leases on them, so no tool or background driver contacts them.
 */
export class ProviderAllowlistError extends Error {
  constructor() {
    super('PUBLIC_PROVIDER_ALLOWLIST must be a JSON array of absolute HTTP(S) provider URLs.');
    this.name = 'ProviderAllowlistError';
  }
}

/** `null` means unrestricted: every provider registered on chain is available. */
export function parseProviderAllowlist(value: string): ReadonlySet<string> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ProviderAllowlistError();
  }
  if (!Array.isArray(parsed)) throw new ProviderAllowlistError();
  const urls = new Set<string>();
  for (const entry of parsed) {
    const url = typeof entry === 'string' ? canonicalProviderUrl(entry) : undefined;
    if (!url) throw new ProviderAllowlistError();
    urls.add(url);
  }
  return urls;
}

let configured: { source: string; result: ReadonlySet<string> | null | ProviderAllowlistError } | undefined;

/** Parse lazily so bad configuration reports through the operation that needs
 * it instead of aborting the application's module imports. Registry reads call
 * this often, so the result is cached per source value. */
export function getProviderAllowlist(): ReadonlySet<string> | null {
  const source = runtimeConfig.PUBLIC_PROVIDER_ALLOWLIST;
  if (configured?.source !== source) {
    let result: ReadonlySet<string> | null | ProviderAllowlistError;
    try {
      result = parseProviderAllowlist(source);
    } catch (error) {
      result = error as ProviderAllowlistError;
    }
    configured = { source, result };
  }
  if (configured.result instanceof ProviderAllowlistError) throw configured.result;
  return configured.result;
}

/** Whether this deployment may use a provider. An invalid setting allows none,
 * and a restricted deployment allows no unknown (empty) provider URL. */
export function isProviderAllowed(providerUrl: string | undefined): boolean {
  let allowlist: ReadonlySet<string> | null;
  try {
    allowlist = getProviderAllowlist();
  } catch {
    return false;
  }
  if (!allowlist) return true;
  const key = providerUrl ? canonicalProviderUrl(providerUrl) : undefined;
  return key !== undefined && allowlist.has(key);
}
