/**
 * Application-wide constants.
 * Extracts magic numbers and configuration values for maintainability.
 */

// ============================================
// Time Constants
// ============================================

/** Number of seconds in one minute */
export const SECONDS_PER_MINUTE = 60;

/** Number of seconds in one hour */
export const SECONDS_PER_HOUR = 3600;

/** Number of seconds in one day */
export const SECONDS_PER_DAY = 86400;

/** Number of milliseconds in one second */
export const MS_PER_SECOND = 1000;

// ============================================
// Polling/Refresh Intervals (in milliseconds)
// ============================================

/** Default auto-refresh interval for data polling */
export const DEFAULT_REFRESH_INTERVAL_MS = 5000;

/** Health check timeout */
export const HEALTH_CHECK_TIMEOUT_MS = 5000;

/** Delay before refetching data after a transaction */
export const POST_TX_REFETCH_DELAY_MS = 1000;

/** Duration to show "copied" feedback */
export const COPY_FEEDBACK_DURATION_MS = 2000;

// ============================================
// UI Constants
// ============================================

/** Default page size for paginated lists */
export const DEFAULT_PAGE_SIZE = 20;

/** Transaction hash display length (truncated) */
export const TX_HASH_DISPLAY_LENGTH = 16;

// ============================================
// Validation Constants
// ============================================

/** Maximum length for reason/description fields */
export const MAX_REASON_LENGTH = 256;

/** Maximum file name length for uploads */
export const MAX_FILENAME_LENGTH = 255;
