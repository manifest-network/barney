import { logError } from '../utils/errors';
import { AI_MAX_RETRIES, AI_RETRY_BASE_DELAY_MS } from '../config/constants';

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
