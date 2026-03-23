/**
 * Fetch adapter for provider API requests.
 * Wraps Barney's SSRF validation and DEV CORS proxy routing into a
 * fetch-compatible function that can be passed as `fetchFn` to
 * @manifest-network/manifest-mcp-fred HTTP functions.
 */

import { parseHttpUrl, isUrlSsrfSafe } from '../utils/url';

/**
 * Creates a fetch function that:
 * - In DEV: routes requests through the `/proxy-provider` CORS proxy
 * - In PROD: validates SSRF safety before making direct requests
 */
export function createProviderFetch(): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (import.meta.env.DEV) {
      const parsed = new URL(url);
      const proxyUrl = `/proxy-provider${parsed.pathname}${parsed.search}`;
      const headers = new Headers(init?.headers);
      headers.set('X-Proxy-Target', parsed.origin);
      return globalThis.fetch(proxyUrl, { ...init, headers });
    }

    // Production: validate SSRF safety
    const parsed = parseHttpUrl(url);
    if (!parsed || !isUrlSsrfSafe(parsed)) {
      throw new Error(`Provider URL blocked by SSRF validation: ${url}`);
    }

    return globalThis.fetch(url, init);
  };
}

/** Module-level singleton for use in tool executors. */
export const providerFetch = createProviderFetch();
