/**
 * Fetch adapter for provider API requests.
 * Wraps Barney's SSRF validation and DEV CORS proxy routing into a
 * fetch-compatible function that can be passed as `fetchFn` to the SDK deploy
 * facade's provider HTTP functions (`@manifest-network/manifest-sdk/deploy`).
 */

import { ProviderApiError } from '@manifest-network/manifest-sdk/deploy';
import { parseHttpUrl, isUrlSsrfSafe } from '../utils/url';

/**
 * Barney's own rejections are hard security blocks, not blips, so they are thrown
 * as `ProviderApiError` tagged `invalid_url` — the SDK's non-transient kind — rather
 * than as a bare `Error`.
 *
 * KNOWN LIMITATION (verified against manifest-mcp-fred 0.21.0
 * `http/provider.js` `classifyTransportError`): the SDK re-wraps ANY rejection from
 * an injected `fetchFn` as `ProviderApiError(0, …, { kind: 'network' })` without
 * inspecting it first, so `isTransientProviderError` still answers `true` for what
 * reaches a caller and the readiness poll still burns its failure budget. The tag
 * survives only on `.cause`. Kept anyway: it is the correct type for a transport
 * adapter to throw, it costs nothing, and it becomes effective the moment the SDK
 * honours an already-classified error. `provider-api.test.ts` pins both halves so
 * an upstream fix surfaces as a failing test rather than going unnoticed.
 */
function blocked(message: string): ProviderApiError {
  return new ProviderApiError(0, message, { kind: 'invalid_url' });
}

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
      // `redirect` AFTER `...init` so a caller can't override it.
      const response = await globalThis.fetch(proxyUrl, { ...init, headers, redirect: 'manual' });
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        throw blocked(`Provider URL blocked: unexpected redirect from ${proxyUrl}`);
      }
      return response;
    }

    // Production: validate SSRF safety and strip embedded credentials
    const parsed = parseHttpUrl(url);
    const safeUrlForError = parsed
      ? `${parsed.origin}${parsed.pathname}${parsed.search}`
      : '[invalid or unsupported URL]';
    if (!parsed || !isUrlSsrfSafe(parsed)) {
      throw blocked(`Provider URL blocked by SSRF validation: ${safeUrlForError}`);
    }

    const sanitizedUrl = `${parsed.origin}${parsed.pathname}${parsed.search}`;
    const response = await globalThis.fetch(sanitizedUrl, { ...init, redirect: 'manual' });
    // Browser opaque-redirect: Location is unreadable, so we cannot re-validate and
    // follow. Provider API calls never legitimately redirect — reject rather than let
    // the browser auto-follow past SSRF validation.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw blocked(`Provider URL blocked: unexpected redirect from ${sanitizedUrl}`);
    }
    return response;
  };
}

/** Module-level singleton for use in fred.ts and provider-api.ts. */
export const providerFetch = createProviderFetch();
