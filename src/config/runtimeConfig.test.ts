import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getConfigValue, getNumericConfig, parsePositiveInt, runtimeConfig, type NumericConfigKey } from './runtimeConfig';

describe('getConfigValue', () => {
  let originalConfig: typeof window.__RUNTIME_CONFIG__;

  beforeEach(() => {
    originalConfig = window.__RUNTIME_CONFIG__;
  });

  afterEach(() => {
    window.__RUNTIME_CONFIG__ = originalConfig;
  });

  it('returns window.__RUNTIME_CONFIG__ value when set', () => {
    window.__RUNTIME_CONFIG__ = { PUBLIC_REST_URL: 'https://runtime.example.com' };
    expect(getConfigValue('PUBLIC_REST_URL')).toBe('https://runtime.example.com');
  });

  it('skips empty string in __RUNTIME_CONFIG__ and falls through to default', () => {
    window.__RUNTIME_CONFIG__ = { PUBLIC_REST_URL: '' };
    expect(getConfigValue('PUBLIC_REST_URL')).toBe('http://localhost:1317');
  });

  it('falls back to defaults when no source provides a value', () => {
    window.__RUNTIME_CONFIG__ = {};
    expect(getConfigValue('PUBLIC_REST_URL')).toBe('http://localhost:1317');
    expect(getConfigValue('PUBLIC_RPC_URL')).toBe('http://localhost:26657');
    expect(getConfigValue('PUBLIC_MORPHEUS_MODEL')).toBe('minimax-m2.5');
    expect(getConfigValue('PUBLIC_WEB3AUTH_CLIENT_ID')).toBe('YOUR_WEB3AUTH_CLIENT_ID');
    expect(getConfigValue('PUBLIC_WEB3AUTH_NETWORK')).toBe('sapphire_devnet');
    expect(getConfigValue('PUBLIC_PWR_DENOM')).toBe(
      'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr'
    );
    expect(getConfigValue('PUBLIC_GAS_PRICE')).toBe(
      '0.0025factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr'
    );
    expect(getConfigValue('PUBLIC_CHAIN_ID')).toBe('manifest-ledger-beta');
  });

  it('skips whitespace-only values and falls through to default', () => {
    window.__RUNTIME_CONFIG__ = { PUBLIC_REST_URL: '   ' };
    expect(getConfigValue('PUBLIC_REST_URL')).toBe('http://localhost:1317');
  });

  it('falls back to defaults when __RUNTIME_CONFIG__ is undefined or missing', () => {
    window.__RUNTIME_CONFIG__ = undefined;
    // Should still return defaults
    expect(getConfigValue('PUBLIC_REST_URL')).toBe('http://localhost:1317');
  });
});

describe('runtimeConfig', () => {
  it('exports all 18 keys as strings', () => {
    expect(Object.keys(runtimeConfig)).toHaveLength(18);
    for (const value of Object.values(runtimeConfig)) {
      expect(typeof value).toBe('string');
    }
  });

  it('defaults PUBLIC_FAUCET_URL to empty string (disabled)', () => {
    window.__RUNTIME_CONFIG__ = {};
    expect(getConfigValue('PUBLIC_FAUCET_URL')).toBe('');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(runtimeConfig)).toBe(true);
  });
});

describe('PUBLIC_SKU_SPECS', () => {
  let originalConfig: typeof window.__RUNTIME_CONFIG__;

  beforeEach(() => {
    originalConfig = window.__RUNTIME_CONFIG__;
  });

  afterEach(() => {
    window.__RUNTIME_CONFIG__ = originalConfig;
  });

  it('returns runtime override when set', () => {
    const json = '{"docker-micro":{"cores":0.5,"ramMB":512,"diskGB":1}}';
    window.__RUNTIME_CONFIG__ = { PUBLIC_SKU_SPECS: json };
    expect(getConfigValue('PUBLIC_SKU_SPECS')).toBe(json);
  });

  it('defaults to empty string when unset', () => {
    window.__RUNTIME_CONFIG__ = {};
    expect(getConfigValue('PUBLIC_SKU_SPECS')).toBe('');
  });
});

describe('parsePositiveInt', () => {
  it('parses valid positive integer', () => {
    expect(parsePositiveInt('30000', 99)).toBe(30000);
  });

  it('returns fallback for empty string', () => {
    expect(parsePositiveInt('', 42)).toBe(42);
  });

  it('returns fallback for non-numeric string', () => {
    expect(parsePositiveInt('abc', 42)).toBe(42);
  });

  it('returns fallback for zero', () => {
    expect(parsePositiveInt('0', 42)).toBe(42);
  });

  it('returns fallback for negative values', () => {
    expect(parsePositiveInt('-5', 42)).toBe(42);
  });

  it('returns fallback for float strings', () => {
    expect(parsePositiveInt('30.5', 42)).toBe(42);
  });

  it('rejects trailing garbage (stricter than parseInt)', () => {
    expect(parsePositiveInt('30000abc', 42)).toBe(42);
  });

  it('clamps values exceeding upper bound', () => {
    expect(parsePositiveInt('999', 3, 10)).toBe(10);
  });

  it('allows values at upper bound', () => {
    expect(parsePositiveInt('10', 3, 10)).toBe(10);
  });

  it('allows values below upper bound', () => {
    expect(parsePositiveInt('5', 3, 10)).toBe(5);
  });

  it('ignores max when not provided', () => {
    expect(parsePositiveInt('999999', 1)).toBe(999999);
  });
});

describe('getNumericConfig', () => {
  // Note: runtimeConfig is frozen at import time, so clamping and edge-case
  // parsing are tested exhaustively via parsePositiveInt above. These tests
  // verify the integration wiring (key lookup + NUMERIC_LIMITS passthrough).

  it('parses valid numeric string from runtime config', () => {
    expect(getNumericConfig('PUBLIC_AI_STREAM_TIMEOUT_MS', 99999)).toBe(30000);
  });

  it('resolves a different numeric key correctly', () => {
    expect(getNumericConfig('PUBLIC_AI_MAX_RETRIES', 1)).toBe(3);
  });

  // Non-numeric keys like PUBLIC_REST_URL are now rejected at compile time
  // via the NumericConfigKey type constraint.
});

describe('NUMERIC_LIMITS headroom', () => {
  let originalConfig: typeof window.__RUNTIME_CONFIG__;

  beforeEach(() => {
    originalConfig = window.__RUNTIME_CONFIG__;
  });

  afterEach(() => {
    window.__RUNTIME_CONFIG__ = originalConfig;
    vi.resetModules();
  });

  /** runtimeConfig is frozen at import time, so an override needs a fresh module. */
  async function resolveWith(
    overrides: Partial<Record<NumericConfigKey, string>>,
    key: NumericConfigKey,
    fallback: number
  ): Promise<number> {
    window.__RUNTIME_CONFIG__ = overrides;
    vi.resetModules();
    const mod = await import('./runtimeConfig');
    return mod.getNumericConfig(key, fallback);
  }

  const NUMERIC_KEYS: NumericConfigKey[] = [
    'PUBLIC_AI_STREAM_TIMEOUT_MS',
    'PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS',
    'PUBLIC_AI_TOOL_API_TIMEOUT_MS',
    'PUBLIC_AI_MAX_RETRIES',
    'PUBLIC_AI_CONFIRMATION_TIMEOUT_MS',
    'PUBLIC_AI_MAX_TOOL_ITERATIONS',
    'PUBLIC_AI_MAX_MESSAGES',
    'PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY',
  ];

  // A ceiling equal to its own default makes the knob one-directional: the
  // operator can only ever turn it down.
  it.each(NUMERIC_KEYS)('%s can be raised above its default', async (key) => {
    const base = await resolveWith({}, key, 1);
    expect(base).toBeGreaterThan(0);
    const raised = await resolveWith({ [key]: String(base * 2) }, key, 1);
    expect(raised).toBeGreaterThan(base);
  });

  it('lets an operator raise the deploy timeout to fred\'s reconcile+provision envelope', async () => {
    expect(await resolveWith(
      { PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS: '900000' },
      'PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS',
      600000
    )).toBe(900000);
  });
});
