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
 * Logs to console in all environments. When backend logging is added,
 * production errors will also be sent to the logging service.
 *
 * @param context - Description of where/what operation failed
 * @param error - The error that occurred
 */
export function logError(context: string, error: unknown): void {
  console.error(`[${context}]`, error);
  // TODO: Add backend logging here when ready
  // if (!import.meta.env.DEV) {
  //   sendErrorToBackend(context, error);
  // }
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

/**
 * Strip trailing period(s) from an error message so it can be safely embedded
 * mid-sentence without producing double-period text.
 *
 * Many upstream error sources (chain responses, fred provider errors, our own
 * `ToolResult.error` strings, `skuTiers` slice errors) end with `.`. When
 * those get interpolated into a wrapping string that supplies its own
 * sentence-final punctuation, the result reads `… already failed.. Use
 * app_status …` — visibly sloppy in the chat bubble.
 *
 * Behavior:
 *  - Input with no trailing period passes through unchanged.
 *  - One or more trailing periods get normalized to zero.
 *  - Internal periods (e.g. "X. final words") are preserved — only the tail
 *    of the string is touched.
 *  - Empty string returns empty string.
 *
 * The intended pattern is:
 *
 *     `Upstream said: ${normalizeErrorPunctuation(err.message)}. Try again.`
 *
 * — the caller's own `.` then provides the single sentence-final period.
 *
 * Reach for this whenever you build a chat-visible error string by embedding
 * an upstream error message followed by your own continuation text.
 */
export function normalizeErrorPunctuation(message: string): string {
  return message.replace(/\.+$/, '');
}
