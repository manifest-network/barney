/**
 * Provider URL validation helpers.
 * Used by fred.ts for WebSocket URL construction (SSRF validation + base URL normalization).
 * HTTP requests use providerFetchAdapter.ts instead.
 */

import { parseHttpUrl, isUrlSsrfSafe } from '../utils/url';

/**
 * Validates that a provider API URL is safe to use.
 * Prevents SSRF attacks by ensuring URL is well-formed http(s) and not pointing
 * to private/internal addresses (in production).
 */
export function validateProviderUrl(url: string): URL {
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    throw new Error(`Invalid provider API URL: ${url || '(empty)'}`);
  }

  if (!isUrlSsrfSafe(parsed)) {
    throw new Error('Provider API URL cannot point to private/internal addresses');
  }

  return parsed;
}

/**
 * Strips trailing slash from a validated URL and returns origin + pathname.
 */
export function normalizeBaseUrl(validated: URL): string {
  return validated.origin + validated.pathname.replace(/\/$/, '');
}
