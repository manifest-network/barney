import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FRED_COMPATIBILITY, fredCompatibilityForProvider, parseFredCompatibility } from './fredCompatibility';

describe('Fred provider contract selection', () => {
  it('explicitly opts dev into PR 240 while retaining v0.13 elsewhere', () => {
    expect(parseFredCompatibility('')).toBe(DEFAULT_FRED_COMPATIBILITY);
    expect(fredCompatibilityForProvider('https://s049-u002.manifest0.net/api/fred/')).toBe('pr240');
    expect(fredCompatibilityForProvider('https://s049-u002.manifest0.net/other')).toBe('v0.13');
    expect(fredCompatibilityForProvider('https://provider.example.com/api/fred')).toBe('v0.13');
  });

  it('normalizes configured URLs and snapshots a replacement map', () => {
    const config = parseFredCompatibility('{"https://EXAMPLE.com:443/api/fred/":"pr240"}');
    expect(Object.isFrozen(config)).toBe(true);
    expect(fredCompatibilityForProvider('https://example.com/api/fred', config)).toBe('pr240');
    expect(fredCompatibilityForProvider('https://s049-u002.manifest0.net/api/fred', config)).toBe('v0.13');
  });

  it.each(['v0.13', 'pr240'] as const)('allows an explicit global %s override', (mode) => {
    expect(fredCompatibilityForProvider('https://provider.example.com', parseFredCompatibility(mode))).toBe(mode);
  });

  it.each([
    'future', 'null', '[]', '{"https://provider.example.com":"future"}',
    '{"/api/fred":"pr240"}', '{"ftp://provider.example.com":"pr240"}',
    '{"https://provider.example.com":"pr240","https://provider.example.com/":"v0.13"}',
  ])('rejects malformed config instead of silently selecting a different protocol: %s', (value) => {
    expect(() => parseFredCompatibility(value)).toThrow('PUBLIC_FRED_COMPATIBILITY');
  });

  it.each(['PR240', '{"provider.example.com":"pr240"}'])('keeps imports usable with invalid config %s and fails only Fred operations', async (value) => {
    vi.resetModules();
    vi.doMock('./runtimeConfig', () => ({ runtimeConfig: { PUBLIC_FRED_COMPATIBILITY: value } }));
    try {
      const config = await import('./fredCompatibility');
      expect(config.DEFAULT_FRED_COMPATIBILITY).toBeDefined();
      expect(() => config.getFredCompatibility()).toThrow('PUBLIC_FRED_COMPATIBILITY');
      expect(() => config.fredCompatibilityForProvider('https://provider.example.com')).toThrow('PUBLIC_FRED_COMPATIBILITY');
    } finally {
      vi.doUnmock('./runtimeConfig');
      vi.resetModules();
    }
  });
});
