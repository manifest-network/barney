/**
 * Application-wide constants.
 * Extracts magic numbers and configuration values for maintainability.
 *
 * AI constants marked with "runtime-configurable" can be overridden via
 * PUBLIC_AI_* environment variables (see runtimeConfig.ts).
 */

import { getNumericConfig } from './runtimeConfig';

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

/** Maximum messages to keep in chat history memory (runtime-configurable) */
export const AI_MAX_MESSAGES = getNumericConfig('PUBLIC_AI_MAX_MESSAGES', 200);

/** Maximum tool call iterations per message (prevents infinite loops) (runtime-configurable) */
export const AI_MAX_TOOL_ITERATIONS = getNumericConfig('PUBLIC_AI_MAX_TOOL_ITERATIONS', 10);

/** Stream chunk timeout in milliseconds (no response received) (runtime-configurable) */
export const AI_STREAM_TIMEOUT_MS = getNumericConfig('PUBLIC_AI_STREAM_TIMEOUT_MS', 30000);

/** Maximum retry attempts for stream operations (runtime-configurable) */
export const AI_MAX_RETRIES = getNumericConfig('PUBLIC_AI_MAX_RETRIES', 3);

/** Base delay for exponential backoff (milliseconds) */
export const AI_RETRY_BASE_DELAY_MS = 1000;

/** Debounce delay for rapid message sends (milliseconds) */
export const AI_MESSAGE_DEBOUNCE_MS = 300;

/** AI API connection health check interval (milliseconds) */
export const AI_HEALTH_CHECK_INTERVAL_MS = 30000;

/** Timeout for pending confirmations before auto-cancel (milliseconds) - 5 minutes (runtime-configurable) */
export const AI_CONFIRMATION_TIMEOUT_MS = getNumericConfig('PUBLIC_AI_CONFIRMATION_TIMEOUT_MS', 300000);

/** Cache TTL for query tool results (milliseconds) - 10 seconds */
export const AI_TOOL_CACHE_TTL_MS = 10000;

/** Maximum number of entries in the tool result cache */
export const AI_TOOL_CACHE_MAX_SIZE = 50;

/** Timeout for blockchain API calls during tool execution (milliseconds) (runtime-configurable) */
export const AI_TOOL_API_TIMEOUT_MS = getNumericConfig('PUBLIC_AI_TOOL_API_TIMEOUT_MS', 15000);

/** Timeout for deploy provisioning polling before giving up (milliseconds) - 5 minutes (runtime-configurable) */
export const AI_DEPLOY_PROVISION_TIMEOUT_MS = getNumericConfig('PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS', 300000);

/** Maximum concurrent app deploys in a batch (runtime-configurable).
 * Limited by provider rate limiting (Fred defaults to 5 req/s per tenant, burst 10). */
export const AI_BATCH_DEPLOY_CONCURRENCY = getNumericConfig('PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY', 4);

// ============================================
// Fred WebSocket / Polling Constants
// ============================================

/** Default polling interval for Fred status checks (milliseconds) */
export const FRED_POLL_INTERVAL_MS = 3000;

/** Delay before reconnecting after a WebSocket connection drop (milliseconds) */
export const WS_RECONNECT_DELAY_MS = 1000;

/** Maximum number of WebSocket reconnection attempts before falling back to polling */
export const WS_MAX_RECONNECT_ATTEMPTS = 2;

/** Timeout for WebSocket liveness — if no data received within this window, reconnect (milliseconds).
 * Fred sends ping frames every 30s, so 45s gives comfortable headroom. */
export const WS_LIVENESS_TIMEOUT_MS = 45_000;

/** SKU name that supports persistent disk storage (hardcoded until Fred exposes this via API) */
export const STORAGE_SKU_NAME = 'docker-small';

// ============================================
// Account Setup Constants
// ============================================

/** Request faucet when wallet MFX balance falls below this (display units, i.e. after fromBaseUnits conversion) */
export const ACCOUNT_SETUP_MFX_THRESHOLD = 0.5;

/** Request faucet when wallet PWR balance falls below this (display units) */
export const ACCOUNT_SETUP_PWR_THRESHOLD = 5;

/** Fund credits when credit account balance falls below this (display units) */
export const ACCOUNT_SETUP_CREDIT_THRESHOLD = 5;

/** PWR amount to fund into credits each time (display units) */
export const ACCOUNT_SETUP_CREDIT_AMOUNT = 10;

/** Polling interval for balance verification after faucet drip (milliseconds) */
export const ACCOUNT_SETUP_POLL_INTERVAL_MS = 2_000;

/** Timeout for balance polling after faucet drip (milliseconds) — block time is ~6s */
export const ACCOUNT_SETUP_POLL_TIMEOUT_MS = 10_000;

/** Delay before dismissing the account setup overlay after completion (milliseconds) */
export const ACCOUNT_SETUP_COMPLETE_DELAY_MS = 1500;

/** Delay before retrying a failed step during initial account setup (milliseconds) */
export const ACCOUNT_SETUP_RETRY_DELAY_MS = 5_000;

/** Delay before dismissing the account setup overlay when an error persists (milliseconds) */
export const ACCOUNT_SETUP_ERROR_DELAY_MS = 5_000;

/** Key used to carry a display-only notice through manifest JSON. Stripped before upload. */
export const MANIFEST_NOTICE_KEY = '_notice' as const;
