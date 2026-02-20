/**
 * Shared provider URL validation and fetch helpers.
 * Used by both provider-api.ts and fred.ts to avoid duplication.
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

/**
 * Build a fetch URL and headers for provider API requests.
 * In development, routes through the CORS proxy with X-Proxy-Target header.
 */
export function buildProviderFetchArgs(
  baseUrl: string,
  path: string,
  extraHeaders?: Record<string, string>
): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...extraHeaders };

  if (import.meta.env.DEV) {
    headers['X-Proxy-Target'] = baseUrl;
    return { url: `/proxy-provider${path}`, headers };
  }

  return { url: `${baseUrl}${path}`, headers };
}

/**
 * Validates a provider URL, normalizes it, and builds fetch args in one step.
 * Combines validateProviderUrl → normalizeBaseUrl → buildProviderFetchArgs.
 */
export function buildValidatedProviderRequest(
  providerApiUrl: string,
  path: string,
  extraHeaders?: Record<string, string>
): { url: string; headers: Record<string, string> } {
  const validatedUrl = validateProviderUrl(providerApiUrl);
  const baseUrl = normalizeBaseUrl(validatedUrl);
  return buildProviderFetchArgs(baseUrl, path, extraHeaders);
}
