import { REST_URL } from './config';

/**
 * Options for fetchJson utility
 */
export interface FetchJsonOptions<TDefault> {
  /**
   * Value to return when the response is 404 Not Found.
   * If not provided, 404 responses will throw an error.
   */
  notFoundDefault?: TDefault;
}

/**
 * Fetches JSON from a URL with consistent error handling.
 *
 * This utility centralizes the common pattern of:
 * - Checking response.ok
 * - Handling 404 responses with optional default values
 * - Parsing JSON response
 * - Throwing descriptive errors
 *
 * @param url - The URL to fetch (can be relative to REST_URL or absolute)
 * @param resourceName - Human-readable name for error messages (e.g., "balance", "lease")
 * @param options - Optional configuration
 * @returns The parsed JSON response
 *
 * @example
 * // Simple fetch that throws on any error
 * const data = await fetchJson<BalanceResponse>('/cosmos/bank/v1beta1/balances/addr', 'balance');
 *
 * @example
 * // Fetch with 404 handling
 * const leases = await fetchJson<LeasesResponse>(url, 'leases', { notFoundDefault: { leases: [] } });
 */
export async function fetchJson<T>(
  url: string,
  resourceName: string,
  options?: FetchJsonOptions<T>
): Promise<T> {
  const fullUrl = url.startsWith('http') ? url : `${REST_URL}${url}`;
  const response = await fetch(fullUrl);

  if (!response.ok) {
    if (response.status === 404 && options?.notFoundDefault !== undefined) {
      return options.notFoundDefault;
    }
    throw new Error(`Failed to fetch ${resourceName}: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Builds a URL with optional query parameters.
 *
 * @param basePath - The base path (will be prefixed with REST_URL)
 * @param params - Optional record of query parameters
 * @returns The full URL with query string
 *
 * @example
 * buildUrl('/liftedinit/billing/v1/leases', { state_filter: 'LEASE_STATE_ACTIVE' })
 * // Returns: "http://localhost:1317/liftedinit/billing/v1/leases?state_filter=LEASE_STATE_ACTIVE"
 */
export function buildUrl(basePath: string, params?: Record<string, string | undefined>): string {
  const url = `${REST_URL}${basePath}`;

  if (!params) return url;

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      searchParams.set(key, value);
    }
  }

  const queryString = searchParams.toString();
  return queryString ? `${url}?${queryString}` : url;
}

/**
 * Creates pagination query parameters for Cosmos SDK pagination.
 *
 * @param options - Pagination options
 * @returns Record of query parameters
 */
export function buildPaginationParams(options?: {
  limit?: number;
  offset?: number;
  paginationKey?: string;
  countTotal?: boolean;
}): Record<string, string | undefined> {
  if (!options) return {};

  return {
    'pagination.limit': options.limit?.toString(),
    'pagination.offset': options.offset?.toString(),
    'pagination.key': options.paginationKey,
    'pagination.count_total': options.countTotal ? 'true' : undefined,
  };
}
