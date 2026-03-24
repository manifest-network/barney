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
    // Extract URL string and merge Request properties into init if needed
    let url: string;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else {
      // input is a Request — preserve its method/body/headers
      url = input.url;
      init = {
        method: input.method,
        headers: input.headers,
        body: input.body,
        ...init, // caller's init overrides Request defaults
      };
    }

    if (import.meta.env.DEV) {
      const parsed = new URL(url);
      const proxyUrl = `/proxy-provider${parsed.pathname}${parsed.search}`;
      const headers = new Headers(init?.headers);
      headers.set('X-Proxy-Target', parsed.origin);
      return globalThis.fetch(proxyUrl, { ...init, headers });
    }

    // Production: validate SSRF safety and strip embedded credentials
    const parsed = parseHttpUrl(url);
    if (!parsed || !isUrlSsrfSafe(parsed)) {
      throw new Error(`Provider URL blocked by SSRF validation: ${url}`);
    }

    const sanitizedUrl = `${parsed.origin}${parsed.pathname}${parsed.search}`;
    return globalThis.fetch(sanitizedUrl, init);
  };
}

/** Module-level singleton for use in fred.ts and provider-api.ts. */
export const providerFetch = createProviderFetch();
