import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfigValue, runtimeConfig } from './runtimeConfig';

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
    expect(getConfigValue('PUBLIC_GAS_PRICE')).toBe('0.0025umfx');
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
  it('exports all 9 keys as strings', () => {
    expect(Object.keys(runtimeConfig)).toHaveLength(9);
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
