/**
 * Standardized error handling utilities.
 * Provides consistent error extraction and logging across the application.
 */

/**
 * Extracts a user-friendly error message from an unknown error.
 *
 * @param error - The caught error (can be any type)
 * @param fallbackMessage - Message to use if error cannot be parsed
 * @returns A string suitable for displaying to users
 */
export function getErrorMessage(
  error: unknown,
  fallbackMessage: string = 'An unexpected error occurred'
): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return fallbackMessage;
}

/**
 * Logs an error with consistent formatting for debugging.
 * Only logs in development mode to avoid cluttering production logs.
 *
 * @param context - Description of where/what operation failed
 * @param error - The error that occurred
 */
export function logError(context: string, error: unknown): void {
  if (import.meta.env.DEV) {
    console.error(`[${context}]`, error);
  }
}

/**
 * Handles an error by logging it and returning a user-friendly message.
 * Combines logError and getErrorMessage for common error handling pattern.
 *
 * @param context - Description of where/what operation failed
 * @param error - The error that occurred
 * @param fallbackMessage - Message to use if error cannot be parsed
 * @returns A string suitable for displaying to users
 */
export function handleError(
  context: string,
  error: unknown,
  fallbackMessage?: string
): string {
  logError(context, error);
  return getErrorMessage(error, fallbackMessage);
}
