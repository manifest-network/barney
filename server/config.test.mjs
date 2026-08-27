// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RelayConfigError, loadRelayConfig, upstreamChatUrl, upstreamModelsUrl } from './config.mjs';

function environment(overrides = {}) {
  return {
    PUBLIC_MORPHEUS_URL: 'https://api.example.test/api/v1/',
    PUBLIC_MORPHEUS_MODEL: 'model-a',
    PUBLIC_CHAIN_ID: 'manifest-test',
    MORPHEUS_API_KEY: 'paid-secret',
    MORPHEUS_RELAY_ALLOWED_ORIGINS: 'https://barney.example.test',
    MORPHEUS_RELAY_IDENTITY_HMAC_KEY: 'identity-hmac-key-at-least-thirty-two-bytes',
    MORPHEUS_RELAY_STATE_FILE: '/tmp/barney-config-test-ledger.json',
    MORPHEUS_RELAY_IDENTITY_DAILY_REQUESTS: '10',
    MORPHEUS_RELAY_IDENTITY_DAILY_TOKENS: '10000',
    MORPHEUS_RELAY_IDENTITY_DAILY_SPEND_MICRO_USD: '1000000',
    MORPHEUS_RELAY_PROVIDER_DAILY_BUDGET_MICRO_USD: '10000000',
    MORPHEUS_RELAY_INPUT_MICRO_USD_PER_MILLION_TOKENS: '1000',
    MORPHEUS_RELAY_OUTPUT_MICRO_USD_PER_MILLION_TOKENS: '2000',
    ...overrides,
  };
}

describe('relay configuration', () => {
  it('builds the sole allowlisted upstream path', () => {
    const config = loadRelayConfig(environment());
    expect(upstreamChatUrl(config).toString()).toBe('https://api.example.test/api/v1/chat/completions');
    expect(upstreamModelsUrl(config).toString()).toBe('https://api.example.test/api/v1/models');
    expect(config.allowedModels).toEqual(new Set(['model-a']));
    expect(config.listenHost).toBe('127.0.0.1');
    expect(config.maxContextBytes).toBe(384 * 1024);
    expect(config.maxDailyIdentities).toBe(1_000);
  });

  it.each([
    'MORPHEUS_RELAY_IDENTITY_DAILY_REQUESTS',
    'MORPHEUS_RELAY_IDENTITY_DAILY_TOKENS',
    'MORPHEUS_RELAY_IDENTITY_DAILY_SPEND_MICRO_USD',
    'MORPHEUS_RELAY_PROVIDER_DAILY_BUDGET_MICRO_USD',
    'MORPHEUS_RELAY_INPUT_MICRO_USD_PER_MILLION_TOKENS',
    'MORPHEUS_RELAY_OUTPUT_MICRO_USD_PER_MILLION_TOKENS',
  ])('fails startup when financial policy %s is missing', (name) => {
    const env = environment();
    delete env[name];
    expect(() => loadRelayConfig(env)).toThrowError(RelayConfigError);
  });

  it('rejects upstream URLs that could redirect or smuggle credentials', () => {
    expect(() => loadRelayConfig(environment({
      PUBLIC_MORPHEUS_URL: 'https://user:pass@example.test/api?key=leak',
    }))).toThrowError(RelayConfigError);
  });

  it('requires the browser model to be in the server allowlist', () => {
    expect(() => loadRelayConfig(environment({
      MORPHEUS_RELAY_ALLOWED_MODELS: 'model-b',
    }))).toThrowError(RelayConfigError);
  });
});
