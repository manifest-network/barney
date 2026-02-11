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

/** Auto-refresh interval for data polling (milliseconds) */
export const AUTO_REFRESH_INTERVAL_MS = 10000;

/** Auto-refresh interval for data polling (seconds) - for display purposes */
export const AUTO_REFRESH_INTERVAL_SECONDS = AUTO_REFRESH_INTERVAL_MS / MS_PER_SECOND;

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
export const DEFAULT_PAGE_SIZE = 10;

/** Transaction hash display length (truncated) */
export const TX_HASH_DISPLAY_LENGTH = 16;

// ============================================
// Validation Constants
// ============================================

/** Maximum length for reason/description fields */
export const MAX_REASON_LENGTH = 256;

/** Maximum file name length for uploads */
export const MAX_FILENAME_LENGTH = 255;

// ============================================
// AI Assistant Constants
// ============================================

/** Maximum messages to keep in chat history memory */
export const AI_MAX_MESSAGES = 200;

/** Maximum tool call iterations per message (prevents infinite loops) */
export const AI_MAX_TOOL_ITERATIONS = 10;

/** Stream chunk timeout in milliseconds (no response received) */
export const AI_STREAM_TIMEOUT_MS = 30000;

/** Maximum retry attempts for stream operations */
export const AI_MAX_RETRIES = 3;

/** Base delay for exponential backoff (milliseconds) */
export const AI_RETRY_BASE_DELAY_MS = 1000;

/** Debounce delay for rapid message sends (milliseconds) */
export const AI_MESSAGE_DEBOUNCE_MS = 300;

/** Ollama connection health check interval (milliseconds) */
export const AI_HEALTH_CHECK_INTERVAL_MS = 30000;

/** Timeout for pending confirmations before auto-cancel (milliseconds) - 5 minutes */
export const AI_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

/** Cache TTL for query tool results (milliseconds) - 10 seconds */
export const AI_TOOL_CACHE_TTL_MS = 10000;

/** Maximum number of entries in the tool result cache */
export const AI_TOOL_CACHE_MAX_SIZE = 50;

/** Timeout for blockchain API calls during tool execution (milliseconds) */
export const AI_TOOL_API_TIMEOUT_MS = 15000;

/** Timeout for deploy provisioning polling before giving up (milliseconds) - 5 minutes */
export const AI_DEPLOY_PROVISION_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================
// Fred SSE / Polling Constants
// ============================================

/** Default polling interval for Fred status checks (milliseconds) */
export const FRED_POLL_INTERVAL_MS = 3000;

/** Delay before reconnecting after an SSE connection drop (milliseconds) */
export const SSE_RECONNECT_DELAY_MS = 2000;

/** Maximum number of SSE reconnection attempts before falling back to polling */
export const SSE_MAX_RECONNECT_ATTEMPTS = 3;

/** Timeout for SSE keepalive — if no data received within this window, reconnect (milliseconds).
 * Fred sends keepalive comments every 30s, so 45s gives comfortable headroom. */
export const SSE_KEEPALIVE_TIMEOUT_MS = 45_000;

/** SKU name that supports persistent disk storage (hardcoded until Fred exposes this via API) */
export const STORAGE_SKU_NAME = 'docker-small';
