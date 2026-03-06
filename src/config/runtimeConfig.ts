/**
 * Runtime configuration with 3-tier fallback:
 * window.__RUNTIME_CONFIG__ → import.meta.env → hardcoded defaults.
 *
 * In development, config.js is an empty placeholder and values come from
 * import.meta.env (Rsbuild inlines PUBLIC_* from .env files).
 *
 * In production, docker/env.sh generates config.js from environment variables
 * at container startup, enabling a single build artifact for all environments.
 *
 * Note: MORPHEUS_API_KEY and PUBLIC_MORPHEUS_URL are server-side only
 * (injected by nginx/dev proxy), never shipped to the browser.
 */

type RuntimeConfigKey =
  | 'PUBLIC_REST_URL'
  | 'PUBLIC_RPC_URL'
  | 'PUBLIC_WEB3AUTH_CLIENT_ID'
  | 'PUBLIC_WEB3AUTH_NETWORK'
  | 'PUBLIC_MORPHEUS_MODEL'
  | 'PUBLIC_PWR_DENOM'
  | 'PUBLIC_GAS_PRICE'
  | 'PUBLIC_CHAIN_ID'
  | 'PUBLIC_FAUCET_URL'
  | 'PUBLIC_AI_STREAM_TIMEOUT_MS'
  | 'PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS'
  | 'PUBLIC_AI_TOOL_API_TIMEOUT_MS'
  | 'PUBLIC_AI_MAX_RETRIES'
  | 'PUBLIC_AI_CONFIRMATION_TIMEOUT_MS'
  | 'PUBLIC_AI_MAX_TOOL_ITERATIONS'
  | 'PUBLIC_AI_MAX_MESSAGES'
  | 'PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY';

type RuntimeConfig = Record<RuntimeConfigKey, string>;

declare global {
  interface Window {
    __RUNTIME_CONFIG__?: Partial<RuntimeConfig>;
  }
}

// Static references so Rsbuild can replace them at build time.
// Dynamic access (import.meta.env[key]) does NOT get replaced.
const BUILD_ENV: RuntimeConfig = {
  PUBLIC_REST_URL: import.meta.env.PUBLIC_REST_URL ?? '',
  PUBLIC_RPC_URL: import.meta.env.PUBLIC_RPC_URL ?? '',
  PUBLIC_WEB3AUTH_CLIENT_ID: import.meta.env.PUBLIC_WEB3AUTH_CLIENT_ID ?? '',
  PUBLIC_WEB3AUTH_NETWORK: import.meta.env.PUBLIC_WEB3AUTH_NETWORK ?? '',
  PUBLIC_MORPHEUS_MODEL: import.meta.env.PUBLIC_MORPHEUS_MODEL ?? '',
  PUBLIC_PWR_DENOM: import.meta.env.PUBLIC_PWR_DENOM ?? '',
  PUBLIC_GAS_PRICE: import.meta.env.PUBLIC_GAS_PRICE ?? '',
  PUBLIC_CHAIN_ID: import.meta.env.PUBLIC_CHAIN_ID ?? '',
  PUBLIC_FAUCET_URL: import.meta.env.PUBLIC_FAUCET_URL ?? '',
  PUBLIC_AI_STREAM_TIMEOUT_MS: import.meta.env.PUBLIC_AI_STREAM_TIMEOUT_MS ?? '',
  PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS: import.meta.env.PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS ?? '',
  PUBLIC_AI_TOOL_API_TIMEOUT_MS: import.meta.env.PUBLIC_AI_TOOL_API_TIMEOUT_MS ?? '',
  PUBLIC_AI_MAX_RETRIES: import.meta.env.PUBLIC_AI_MAX_RETRIES ?? '',
  PUBLIC_AI_CONFIRMATION_TIMEOUT_MS: import.meta.env.PUBLIC_AI_CONFIRMATION_TIMEOUT_MS ?? '',
  PUBLIC_AI_MAX_TOOL_ITERATIONS: import.meta.env.PUBLIC_AI_MAX_TOOL_ITERATIONS ?? '',
  PUBLIC_AI_MAX_MESSAGES: import.meta.env.PUBLIC_AI_MAX_MESSAGES ?? '',
  PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY: import.meta.env.PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY ?? '',
};

const DEFAULTS: RuntimeConfig = {
  PUBLIC_REST_URL: 'http://localhost:1317',
  PUBLIC_RPC_URL: 'http://localhost:26657',
  PUBLIC_WEB3AUTH_CLIENT_ID: 'YOUR_WEB3AUTH_CLIENT_ID',
  PUBLIC_WEB3AUTH_NETWORK: 'sapphire_devnet',
  PUBLIC_MORPHEUS_MODEL: 'minimax-m2.5',
  PUBLIC_PWR_DENOM:
    'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr',
  PUBLIC_GAS_PRICE: '0.0025umfx',
  PUBLIC_CHAIN_ID: 'manifest-ledger-beta',
  PUBLIC_FAUCET_URL: '',
  PUBLIC_AI_STREAM_TIMEOUT_MS: '30000',
  PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS: '300000',
  PUBLIC_AI_TOOL_API_TIMEOUT_MS: '15000',
  PUBLIC_AI_MAX_RETRIES: '3',
  PUBLIC_AI_CONFIRMATION_TIMEOUT_MS: '300000',
  PUBLIC_AI_MAX_TOOL_ITERATIONS: '10',
  PUBLIC_AI_MAX_MESSAGES: '200',
  PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY: '4',
};

/** Keys that represent numeric (positive-integer) config values.
 *  A typo here is caught at compile time by the `runtimeConfig[key]` access in getNumericConfig. */
export type NumericConfigKey =
  | 'PUBLIC_AI_STREAM_TIMEOUT_MS'
  | 'PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS'
  | 'PUBLIC_AI_TOOL_API_TIMEOUT_MS'
  | 'PUBLIC_AI_MAX_RETRIES'
  | 'PUBLIC_AI_CONFIRMATION_TIMEOUT_MS'
  | 'PUBLIC_AI_MAX_TOOL_ITERATIONS'
  | 'PUBLIC_AI_MAX_MESSAGES'
  | 'PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY';

/** Upper bounds for numeric config keys to prevent misconfiguration. */
const NUMERIC_LIMITS: Record<NumericConfigKey, number> = {
  PUBLIC_AI_STREAM_TIMEOUT_MS: 120_000,
  PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS: 600_000,
  PUBLIC_AI_TOOL_API_TIMEOUT_MS: 60_000,
  PUBLIC_AI_MAX_RETRIES: 10,
  PUBLIC_AI_CONFIRMATION_TIMEOUT_MS: 600_000,
  PUBLIC_AI_MAX_TOOL_ITERATIONS: 50,
  PUBLIC_AI_MAX_MESSAGES: 1000,
  PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY: 10,
};

export function getConfigValue(key: RuntimeConfigKey): string {
  const runtimeVal = window.__RUNTIME_CONFIG__?.[key]?.trim();
  if (runtimeVal && runtimeVal.length > 0) return runtimeVal;

  const envVal = BUILD_ENV[key]?.trim();
  if (envVal && envVal.length > 0) return envVal;

  return DEFAULTS[key];
}

export const runtimeConfig: Readonly<RuntimeConfig> = Object.freeze({
  PUBLIC_REST_URL: getConfigValue('PUBLIC_REST_URL'),
  PUBLIC_RPC_URL: getConfigValue('PUBLIC_RPC_URL'),
  PUBLIC_WEB3AUTH_CLIENT_ID: getConfigValue('PUBLIC_WEB3AUTH_CLIENT_ID'),
  PUBLIC_WEB3AUTH_NETWORK: getConfigValue('PUBLIC_WEB3AUTH_NETWORK'),
  PUBLIC_MORPHEUS_MODEL: getConfigValue('PUBLIC_MORPHEUS_MODEL'),
  PUBLIC_PWR_DENOM: getConfigValue('PUBLIC_PWR_DENOM'),
  PUBLIC_GAS_PRICE: getConfigValue('PUBLIC_GAS_PRICE'),
  PUBLIC_CHAIN_ID: getConfigValue('PUBLIC_CHAIN_ID'),
  PUBLIC_FAUCET_URL: getConfigValue('PUBLIC_FAUCET_URL'),
  PUBLIC_AI_STREAM_TIMEOUT_MS: getConfigValue('PUBLIC_AI_STREAM_TIMEOUT_MS'),
  PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS: getConfigValue('PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS'),
  PUBLIC_AI_TOOL_API_TIMEOUT_MS: getConfigValue('PUBLIC_AI_TOOL_API_TIMEOUT_MS'),
  PUBLIC_AI_MAX_RETRIES: getConfigValue('PUBLIC_AI_MAX_RETRIES'),
  PUBLIC_AI_CONFIRMATION_TIMEOUT_MS: getConfigValue('PUBLIC_AI_CONFIRMATION_TIMEOUT_MS'),
  PUBLIC_AI_MAX_TOOL_ITERATIONS: getConfigValue('PUBLIC_AI_MAX_TOOL_ITERATIONS'),
  PUBLIC_AI_MAX_MESSAGES: getConfigValue('PUBLIC_AI_MAX_MESSAGES'),
  PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY: getConfigValue('PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY'),
});

/** Parse a string as a positive integer with optional upper-bound clamping.
 *  Returns fallback for non-numeric, non-integer, zero, or negative values. */
export function parsePositiveInt(value: string, fallback: number, max?: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return max !== undefined && n > max ? max : n;
}

/** Parse a runtime config value as a positive integer, falling back to the provided default.
 *  Values ≤ 0, non-numeric strings, and values exceeding the upper bound are rejected. */
export function getNumericConfig(key: NumericConfigKey, fallback: number): number {
  return parsePositiveInt(runtimeConfig[key], fallback, NUMERIC_LIMITS[key]);
}
