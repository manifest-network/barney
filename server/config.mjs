import { resolve } from 'node:path';

export class RelayConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RelayConfigError';
  }
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new RelayConfigError(`${name} is required`);
  return value;
}

function positiveInteger(env, name, fallback, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name]?.trim();
  if (!raw && fallback !== undefined) return fallback;
  if (!raw) throw new RelayConfigError(`${name} is required`);

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new RelayConfigError(`${name} must be a positive integer no greater than ${max}`);
  }
  return value;
}

function booleanValue(env, name, fallback) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new RelayConfigError(`${name} must be true or false`);
}

function csv(env, name, fallback = []) {
  const raw = env[name]?.trim();
  const values = raw ? raw.split(',') : fallback;
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (normalized.length === 0) throw new RelayConfigError(`${name} must contain at least one value`);
  return normalized;
}

function parseUpstream(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RelayConfigError('PUBLIC_MORPHEUS_URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new RelayConfigError('PUBLIC_MORPHEUS_URL must use HTTP or HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new RelayConfigError('PUBLIC_MORPHEUS_URL must not contain credentials, a query, or a fragment');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

function parseOrigins(values) {
  return new Set(values.map((value) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new RelayConfigError(`Invalid MORPHEUS_RELAY_ALLOWED_ORIGINS entry: ${value}`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new RelayConfigError(`MORPHEUS_RELAY_ALLOWED_ORIGINS entries must be bare HTTP(S) origins: ${value}`);
    }
    return url.origin;
  }));
}

/**
 * Load and validate the relay's complete fail-closed policy.
 *
 * Every financial limit is required. A missing value is a startup error rather
 * than an implicit unlimited budget.
 */
export function loadRelayConfig(env = process.env) {
  const apiKey = required(env, 'MORPHEUS_API_KEY');
  const publicModel = required(env, 'PUBLIC_MORPHEUS_MODEL');
  const allowedModels = new Set(csv(env, 'MORPHEUS_RELAY_ALLOWED_MODELS', [publicModel]));
  if (!allowedModels.has(publicModel)) {
    throw new RelayConfigError('PUBLIC_MORPHEUS_MODEL must be present in MORPHEUS_RELAY_ALLOWED_MODELS');
  }

  // A dedicated key is optional. Falling back to the already-required provider
  // secret avoids another vault item while still keeping wallet addresses out
  // of the durable ledger and metrics. Rotating the provider key intentionally
  // starts new per-identity pseudonyms; the provider-wide ledger is unaffected.
  const identityHmacKey = env.MORPHEUS_RELAY_IDENTITY_HMAC_KEY?.trim() || apiKey;

  const stateFile = resolve(required(env, 'MORPHEUS_RELAY_STATE_FILE'));

  return Object.freeze({
    upstreamBaseUrl: parseUpstream(required(env, 'PUBLIC_MORPHEUS_URL')),
    apiKey,
    chainId: required(env, 'PUBLIC_CHAIN_ID'),
    addressPrefix: env.MORPHEUS_RELAY_ADDRESS_PREFIX?.trim() || 'manifest',
    audience: env.MORPHEUS_RELAY_AUDIENCE?.trim() || 'barney-morpheus-relay',
    publicModel,
    allowedModels,
    allowedOrigins: parseOrigins(csv(env, 'MORPHEUS_RELAY_ALLOWED_ORIGINS')),
    identityHmacKey,
    stateFile,
    listenHost: env.MORPHEUS_RELAY_HOST?.trim() || '0.0.0.0',
    listenPort: positiveInteger(env, 'MORPHEUS_RELAY_PORT', 8081, { max: 65_535 }),
    cookieSecure: booleanValue(env, 'MORPHEUS_RELAY_COOKIE_SECURE', true),
    challengeTtlMs: positiveInteger(env, 'MORPHEUS_RELAY_CHALLENGE_TTL_SECONDS', 120, { max: 600 }) * 1000,
    sessionTtlMs: positiveInteger(env, 'MORPHEUS_RELAY_SESSION_TTL_SECONDS', 3600, { max: 86_400 }) * 1000,
    maxChallenges: positiveInteger(env, 'MORPHEUS_RELAY_MAX_PENDING_CHALLENGES', 10_000, { max: 100_000 }),
    maxSessions: positiveInteger(env, 'MORPHEUS_RELAY_MAX_SESSIONS', 10_000, { max: 100_000 }),
    maxAuthBodyBytes: positiveInteger(env, 'MORPHEUS_RELAY_MAX_AUTH_BODY_BYTES', 16 * 1024, { max: 64 * 1024 }),
    maxRequestBodyBytes: positiveInteger(env, 'MORPHEUS_RELAY_MAX_BODY_BYTES', 512 * 1024, { max: 4 * 1024 * 1024 }),
    maxPromptChars: positiveInteger(env, 'MORPHEUS_RELAY_MAX_PROMPT_CHARS', 32_000, { max: 1_000_000 }),
    maxContextTokens: positiveInteger(env, 'MORPHEUS_RELAY_MAX_CONTEXT_TOKENS', 64_000, { max: 2_000_000 }),
    maxOutputTokens: positiveInteger(env, 'MORPHEUS_RELAY_MAX_OUTPUT_TOKENS', 4096, { max: 65_536 }),
    maxMessages: positiveInteger(env, 'MORPHEUS_RELAY_MAX_MESSAGES', 200, { max: 2_000 }),
    maxUpstreamResponseBytes: positiveInteger(env, 'MORPHEUS_RELAY_MAX_RESPONSE_BYTES', 8 * 1024 * 1024, { max: 64 * 1024 * 1024 }),
    maxIdentityConcurrent: positiveInteger(env, 'MORPHEUS_RELAY_MAX_IDENTITY_CONCURRENT', 2, { max: 100 }),
    maxProviderConcurrent: positiveInteger(env, 'MORPHEUS_RELAY_MAX_PROVIDER_CONCURRENT', 16, { max: 1_000 }),
    streamTimeoutMs: positiveInteger(env, 'MORPHEUS_RELAY_MAX_STREAM_SECONDS', 120, { max: 900 }) * 1000,
    upstreamConnectTimeoutMs: positiveInteger(env, 'MORPHEUS_RELAY_UPSTREAM_CONNECT_TIMEOUT_SECONDS', 15, { max: 120 }) * 1000,
    identityDailyRequests: positiveInteger(env, 'MORPHEUS_RELAY_IDENTITY_DAILY_REQUESTS'),
    identityDailyTokens: positiveInteger(env, 'MORPHEUS_RELAY_IDENTITY_DAILY_TOKENS'),
    identityDailySpendMicroUsd: positiveInteger(env, 'MORPHEUS_RELAY_IDENTITY_DAILY_SPEND_MICRO_USD'),
    providerDailyBudgetMicroUsd: positiveInteger(env, 'MORPHEUS_RELAY_PROVIDER_DAILY_BUDGET_MICRO_USD'),
    inputMicroUsdPerMillionTokens: positiveInteger(env, 'MORPHEUS_RELAY_INPUT_MICRO_USD_PER_MILLION_TOKENS'),
    outputMicroUsdPerMillionTokens: positiveInteger(env, 'MORPHEUS_RELAY_OUTPUT_MICRO_USD_PER_MILLION_TOKENS'),
  });
}

export function upstreamChatUrl(config) {
  return new URL('chat/completions', config.upstreamBaseUrl);
}
