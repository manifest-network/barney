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
export const AUTO_REFRESH_INTERVAL_MS = 15_000;

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
export const AI_HEALTH_CHECK_INTERVAL_MS = 60_000;

/** Maximum backoff multiplier for health check (base * multiplier = max interval) */
export const AI_HEALTH_CHECK_MAX_BACKOFF = 8;

/** Timeout for pending confirmations before auto-cancel (milliseconds) - 5 minutes (runtime-configurable) */
export const AI_CONFIRMATION_TIMEOUT_MS = getNumericConfig('PUBLIC_AI_CONFIRMATION_TIMEOUT_MS', 300000);

/** Cache TTL for query tool results (milliseconds) - 10 seconds */
export const AI_TOOL_CACHE_TTL_MS = 10000;

/** Maximum number of entries in the tool result cache */
export const AI_TOOL_CACHE_MAX_SIZE = 50;

/** Timeout for blockchain API calls during tool execution (milliseconds) (runtime-configurable) */
export const AI_TOOL_API_TIMEOUT_MS = getNumericConfig('PUBLIC_AI_TOOL_API_TIMEOUT_MS', 15000);

/** Timeout for deploy provisioning polling before giving up (milliseconds) - 10 minutes (runtime-configurable).
 *
 * Sized to fred's OWN provisioning budget, not to a UI patience figure: fred
 * `internal/backend/docker/config.go` (v0.13.0) defaults `ImagePullTimeout: 5m`
 * and `ProvisionTimeout: 10m`. A shorter deadline gives up while the provider is
 * still legitimately working. Re-check those values on the next provider bump.
 *
 * NOTE: `runtimeConfig.DEFAULTS` carries the effective default (this literal is
 * never reached while that entry is non-empty), so keep the two in step.
 * `NUMERIC_LIMITS` caps operator overrides at 900000 — the AI_LEASE_WAIT_TIMEOUT_MS
 * envelope, so the knob can be raised as well as lowered.
 */
export const AI_DEPLOY_PROVISION_TIMEOUT_MS = getNumericConfig('PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS', 600000);

/** Deadline for the restart/update readiness wait (milliseconds) - 15 minutes.
 *
 * Longer than the deploy timeout because the worst case is different: SDK 0.21
 * narrowed `classifyTerminal`'s ACTIVE arm to a `PROVISION_SUCCESS = {'ready'}`
 * allowlist, so an ACTIVE lease whose provision is `retained` no longer resolves
 * immediately — it stays `pending` until fred's reconciler re-provisions it.
 * Reaching the deadline REJECTS, and barney's catch marks the registry entry
 * 'failed', mislabelling an app that is on its way back up. So the budget is
 * fred's worst case: up to one `ReconcileInterval` (5m) before the reconciler
 * picks the lease up, plus a full `ProvisionTimeout` (10m) to re-provision it —
 * both from fred `internal/backend/docker/config.go` (v0.13.0).
 * Not runtime-configurable: it tracks provider config, not operator taste.
 */
export const AI_LEASE_WAIT_TIMEOUT_MS = 900_000;

/** Maximum concurrent app deploys in a batch (runtime-configurable).
 * Limited by provider rate limiting (Fred defaults to 5 req/s per tenant, burst 10). */
export const AI_BATCH_DEPLOY_CONCURRENCY = getNumericConfig('PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY', 4);

// ============================================
// Fred WebSocket / Polling Constants
// ============================================

/** Default polling interval for Fred status checks (milliseconds). Passed as
 *  intervalMs to the SDK's waitForLeaseStatus (also its WS-fallback poll cadence). */
export const FRED_POLL_INTERVAL_MS = 3000;

// ============================================
// Custom Domain DNS Polling Constants
// ============================================

/** Polling interval for browser-side DNS / HTTPS probes (milliseconds).
 * Cloudflare DoH allows generous limits; revisit only if rate-limiting appears. */
export const DNS_POLL_INTERVAL_MS = 30_000;

/** After this long stuck in pending_dns (no detail attached), surface a
 * "verify with dig locally" hint — likely a network block. */
export const DNS_STUCK_THRESHOLD_MS = 5 * 60 * 1000;

// ============================================
// Account Setup Constants
// ============================================

/** Request faucet when wallet PWR balance falls below this (display units, i.e. after fromBaseUnits conversion) */
export const ACCOUNT_SETUP_PWR_THRESHOLD = 5;

/** Fund credits when credit account balance falls below this (display units) */
export const ACCOUNT_SETUP_CREDIT_THRESHOLD = 5;

/** PWR amount to fund into credits each time (display units). Kept BELOW the
 *  faucet drip so PWR stays in the wallet to pay gas: after the ENG-243 PWR
 *  gas cutover the fund-credit gas fee is deducted from this same PWR balance
 *  by the ante BEFORE the message executes, so crediting the entire faucet drip
 *  overdraws by exactly the fee (ENG-565). */
export const ACCOUNT_SETUP_CREDIT_AMOUNT = 5;

/** PWR headroom (display units) reserved for gas. The funding guard requires
 *  balance ≥ credit + this reserve so the fund-credit TX never overdraws
 *  (worst-case prod fee ≈ 0.053 PWR, so 1 PWR is a comfortable floor). */
export const ACCOUNT_SETUP_GAS_RESERVE = 1;

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

/**
 * Internal sentinel that requests a generated password be appended in place of
 * the marker. Used ONLY by curated KNOWN_IMAGES/KNOWN_STACKS defaults (e.g.
 * neo4j's `NEO4J_AUTH: 'neo4j/{{GENERATED_PASSWORD}}'` → `neo4j/<random>`), not
 * exposed to users. A bare trailing "/" was previously the marker, which
 * silently corrupted legitimate trailing-slash values like
 * `NEXTAUTH_URL=https://app/` (ENG-574); the explicit token can't collide with
 * a real value. Lives here (a leaf module) rather than in manifest.ts so
 * knownImages.ts can reference it without a runtime edge into the manifest
 * builder + its SDK dependency.
 */
export const GENERATED_PASSWORD_MARKER = '{{GENERATED_PASSWORD}}';
