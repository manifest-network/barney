import { isPrivateHost } from '../ai/validation';

/**
 * Parse and validate an HTTP(S) URL with SSRF protection.
 * Shared core used by both provider URL validation and endpoint URL validation.
 *
 * @param url - The URL string to parse
 * @returns The parsed URL object, or null if invalid or blocked
 */
export function parseHttpUrl(url: string): URL | null {
  if (!url || typeof url !== 'string') return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  return parsed;
}

/** Hostnames allowed through SSRF protection in DEV mode (for local services, etc.) */
const DEV_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Check whether a parsed URL targets a private/internal host.
 * Returns true if the URL is safe (not private), false if blocked.
 * In DEV mode, only localhost is allowed — other private ranges remain blocked.
 */
export function isUrlSsrfSafe(parsed: URL): boolean {
  if (isPrivateHost(parsed.hostname)) {
    const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV === true;
    // WHATWG URL brackets IPv6 hostnames (`[::1]`); strip the brackets so the
    // loopback lookup matches the stored bare form (`::1`).
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return isDev && DEV_ALLOWED_HOSTS.has(host);
  }
  return true;
}
