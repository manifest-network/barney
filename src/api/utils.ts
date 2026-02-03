import { z } from 'zod';
import { REST_URL } from './config';
import { logError } from '../utils/errors';
import { AI_MAX_RETRIES, AI_RETRY_BASE_DELAY_MS } from '../config/constants';

// ============================================
// Retry Logic
// ============================================

/**
 * Checks if an error is transient and should be retried.
 */
function isTransientError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('fetch') ||
    message.includes('network') ||
    message.includes('econnrefused') ||
    message.includes('timeout') ||
    message.includes('failed to fetch') ||
    message.includes('load failed') ||
    error.name === 'TypeError' // Often indicates network issues
  );
}

/**
 * Executes a function with exponential backoff retry logic.
 * Retries on transient network errors (connection refused, timeout, etc.)
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration
 * @returns The result of the function
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;
    baseDelay?: number;
    context?: string;
  }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? AI_MAX_RETRIES;
  const baseDelay = options?.baseDelay ?? AI_RETRY_BASE_DELAY_MS;
  const context = options?.context ?? 'withRetry';
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on abort
      if (lastError.name === 'AbortError') {
        throw lastError;
      }

      // Check if error is transient
      if (!isTransientError(lastError) || attempt === maxRetries) {
        throw lastError;
      }

      // Log retry attempt
      logError(`${context}.retry (attempt ${attempt + 1}/${maxRetries + 1})`, lastError);

      // Exponential backoff with jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 100;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// ============================================
// Fetch Utilities
// ============================================

/**
 * Options for fetchJson utility
 */
export interface FetchJsonOptions<TDefault, TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  /**
   * Value to return when the response is 404 Not Found.
   * If not provided, 404 responses will throw an error.
   */
  notFoundDefault?: TDefault;
  /**
   * Enable retry logic for transient network errors.
   * Default: false
   */
  retry?: boolean;
  /**
   * Maximum number of retry attempts.
   * Default: 3
   */
  maxRetries?: number;
  /**
   * Base delay for exponential backoff in milliseconds.
   * Default: 1000
   */
  baseDelay?: number;
  /**
   * Zod schema to validate the response against.
   * If validation fails, an error is thrown with details.
   */
  schema?: TSchema;
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

  const doFetch = async (): Promise<T> => {
    const response = await fetch(fullUrl);

    if (!response.ok) {
      if (response.status === 404 && options?.notFoundDefault !== undefined) {
        return options.notFoundDefault;
      }
      throw new Error(`Failed to fetch ${resourceName}: ${response.statusText}`);
    }

    const data = await response.json();

    // Validate against schema if provided
    if (options?.schema) {
      const result = options.schema.safeParse(data);
      if (!result.success) {
        logError(`fetchJson.${resourceName}.validation`, result.error);
        throw new Error(`Invalid ${resourceName} response: ${result.error.message}`);
      }
      return result.data as T;
    }

    return data;
  };

  // Use retry logic if enabled
  if (options?.retry) {
    return withRetry(doFetch, {
      maxRetries: options.maxRetries,
      baseDelay: options.baseDelay,
      context: `fetchJson.${resourceName}`,
    });
  }

  return doFetch();
}

/**
 * Fetches JSON from a URL with required schema validation.
 * Returns the validated and typed response.
 *
 * @param url - The URL to fetch
 * @param resourceName - Human-readable name for error messages
 * @param schema - Zod schema to validate the response
 * @param options - Optional configuration (notFoundDefault, retry settings)
 * @returns The validated and typed response
 *
 * @example
 * const data = await fetchJsonValidated('/api/providers', 'providers', ProvidersResponseSchema);
 * // data is typed as z.infer<typeof ProvidersResponseSchema>
 */
export async function fetchJsonValidated<TSchema extends z.ZodTypeAny>(
  url: string,
  resourceName: string,
  schema: TSchema,
  options?: Omit<FetchJsonOptions<z.infer<TSchema>>, 'schema'>
): Promise<z.infer<TSchema>> {
  return fetchJson(url, resourceName, { ...options, schema });
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
