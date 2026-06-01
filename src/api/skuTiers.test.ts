import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCheapestTier, hourlyPriceFromSku, resolveSizeName, resolveSkuTiers, resolveSizeOrCheapest, formatTierSpecs } from './skuTiers';
import type { ResolvedSkuTier } from './skuTiers';
import { Unit } from './sku';
import type { SKU } from './sku';

function tier(overrides: Partial<ResolvedSkuTier>): ResolvedSkuTier {
  return {
    skuName: 'docker-micro',
    skuUuid: 'u',
    providerUuid: 'p',
    cores: 1,
    ramMB: 1024,
    diskGB: 5,
    pricePerHour: 0.1,
    denomSymbol: 'PWR',
    unit: 1,
    ...overrides,
  };
}

vi.mock('./sku', async (orig) => {
  const actual = await orig<typeof import('./sku')>();
  return {
    ...actual,
    getSKUs: vi.fn() as typeof actual.getSKUs,
  };
});

import { getSKUs } from './sku';

function sku(overrides: Partial<SKU> = {}): SKU {
  return {
    uuid: 'sku-1',
    name: 'docker-micro',
    providerUuid: 'prov-1',
    unit: Unit.UNIT_PER_HOUR,
    basePrice: { amount: '36000', denom: 'upwr' },  // 0.036 PWR per hour
    active: true,
    description: '',
    metadata: '',
    ...overrides,
  } as SKU;
}

describe('hourlyPriceFromSku', () => {
  it('returns base price as-is for UNIT_PER_HOUR', () => {
    const s = sku({ unit: Unit.UNIT_PER_HOUR, basePrice: { amount: '36000', denom: 'upwr' } });
    expect(hourlyPriceFromSku(s)).toBeCloseTo(0.036);
  });

  it('divides by 24 for UNIT_PER_DAY', () => {
    const s = sku({ unit: Unit.UNIT_PER_DAY, basePrice: { amount: '24000000', denom: 'upwr' } });
    // 24 PWR/day → 1 PWR/hour
    expect(hourlyPriceFromSku(s)).toBeCloseTo(1.0);
  });

  it('defaults to per-hour for UNIT_UNSPECIFIED (logs warning)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = sku({ unit: Unit.UNIT_UNSPECIFIED, basePrice: { amount: '50000', denom: 'upwr' } });
    expect(hourlyPriceFromSku(s)).toBeCloseTo(0.05);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns 0 when basePrice is missing', () => {
    const s = { ...sku(), basePrice: undefined as unknown as SKU['basePrice'] };
    expect(hourlyPriceFromSku(s)).toBe(0);
  });
});

describe('resolveSkuTiers', () => {
  beforeEach(() => vi.mocked(getSKUs).mockReset());

  it('returns chain ∩ env intersection', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      sku({ uuid: 'a', name: 'docker-micro' }),
      sku({ uuid: 'b', name: 'docker-small', basePrice: { amount: '100000', denom: 'upwr' } }),
    ]);
    const specs = {
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
      'docker-small': { cores: 1, ramMB: 1024, diskGB: 5 },
    };
    const result = await resolveSkuTiers(specs);
    expect(result.tiers.map(t => t.skuName)).toEqual(['docker-micro', 'docker-small']);
    expect(result.tiers[0].pricePerHour).toBeCloseTo(0.036);
    expect(result.tiers[0].cores).toBe(0.5);
    expect(result.denomSymbol).toBe('PWR');
  });

  it('omits chain SKUs not present in env specs, warns to console', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getSKUs).mockResolvedValue([
      sku({ uuid: 'a', name: 'docker-micro' }),
      sku({ uuid: 'b', name: 'gpu-large' }),
    ]);
    const specs = {
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
    };
    const result = await resolveSkuTiers(specs);
    expect(result.tiers.map(t => t.skuName)).toEqual(['docker-micro']);
    expect(spy).toHaveBeenCalled();  // missing-spec warning logged
    spy.mockRestore();
  });

  it('passes activeOnly=true to getSKUs', async () => {
    vi.mocked(getSKUs).mockResolvedValue([sku({ active: true })]);
    const result = await resolveSkuTiers({ 'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 } });
    expect(result.tiers).toHaveLength(1);
    expect(vi.mocked(getSKUs)).toHaveBeenCalledWith(true);
  });

  it('propagates fetch errors', async () => {
    vi.mocked(getSKUs).mockRejectedValueOnce(new Error('network down'));
    let caught: Error | null = null;
    try {
      await resolveSkuTiers({ 'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 } });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toBe('network down');
  });

  it('preserves stable order by spec key insertion', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      sku({ uuid: 'b', name: 'docker-small', basePrice: { amount: '100000', denom: 'upwr' } }),
      sku({ uuid: 'a', name: 'docker-micro' }),
    ]);
    const specs = {
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
      'docker-small': { cores: 1, ramMB: 1024, diskGB: 5 },
    };
    const result = await resolveSkuTiers(specs);
    expect(result.tiers.map(t => t.skuName)).toEqual(['docker-micro', 'docker-small']);
  });

  it('does not warn when all chain SKUs are in spec map', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getSKUs).mockResolvedValue([
      sku({ uuid: 'a', name: 'docker-micro' }),
    ]);
    await resolveSkuTiers({ 'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 } });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('preserves existing behavior when each SKU name is offered by a single provider', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      sku({ uuid: 'a', name: 'docker-micro', providerUuid: 'p1', basePrice: { amount: '36000', denom: 'upwr' } }),
      sku({ uuid: 'b', name: 'docker-small', providerUuid: 'p2', basePrice: { amount: '100000', denom: 'upwr' } }),
    ]);
    const result = await resolveSkuTiers({
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
      'docker-small': { cores: 1, ramMB: 1024, diskGB: 5 },
    });
    expect(result.tiers.map(t => ({ name: t.skuName, provider: t.providerUuid }))).toEqual([
      { name: 'docker-micro', provider: 'p1' },
      { name: 'docker-small', provider: 'p2' },
    ]);
  });

  it('when multiple providers offer the same SKU name, picks the cheapest provider', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      // p1 offers docker-micro at 0.1 PWR/hour
      sku({ uuid: 'a', name: 'docker-micro', providerUuid: 'p1', basePrice: { amount: '100000', denom: 'upwr' } }),
      // p2 offers docker-micro at 0.036 PWR/hour — cheapest
      sku({ uuid: 'b', name: 'docker-micro', providerUuid: 'p2', basePrice: { amount: '36000', denom: 'upwr' } }),
      // p3 offers docker-micro at 0.2 PWR/hour — expensive
      sku({ uuid: 'c', name: 'docker-micro', providerUuid: 'p3', basePrice: { amount: '200000', denom: 'upwr' } }),
    ]);
    const result = await resolveSkuTiers({
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
    });
    expect(result.tiers).toHaveLength(1);
    expect(result.tiers[0].providerUuid).toBe('p2');
    expect(result.tiers[0].skuUuid).toBe('b');
    expect(result.tiers[0].pricePerHour).toBeCloseTo(0.036);
  });

  it('multi-provider tie-break: first occurrence wins', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      sku({ uuid: 'a', name: 'docker-micro', providerUuid: 'p1', basePrice: { amount: '100000', denom: 'upwr' } }),
      sku({ uuid: 'b', name: 'docker-micro', providerUuid: 'p2', basePrice: { amount: '100000', denom: 'upwr' } }),
    ]);
    const result = await resolveSkuTiers({
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
    });
    expect(result.tiers[0].providerUuid).toBe('p1');
    expect(result.tiers[0].skuUuid).toBe('a');
  });

  it('does not warn for chain SKUs that lose the multi-provider tie (they are part of the same name)', async () => {
    // Multi-provider duplicates of a chosen-spec name should NOT trigger
    // the "no spec entry" warning — the spec name IS matched, just by a
    // different provider's SKU.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getSKUs).mockResolvedValue([
      sku({ uuid: 'a', name: 'docker-micro', providerUuid: 'p1', basePrice: { amount: '100000', denom: 'upwr' } }),
      sku({ uuid: 'b', name: 'docker-micro', providerUuid: 'p2', basePrice: { amount: '36000', denom: 'upwr' } }),
    ]);
    await resolveSkuTiers({ 'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 } });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('skips candidates with missing basePrice (cheapest-pick must not pretend they are free)', async () => {
    // Pass-11 fix #2: hourlyPriceFromSku returns 0 for missing basePrice,
    // which would make an unpriced SKU appear "free" and beat every priced
    // candidate in the cheapest-pick loop. Filter unpriced candidates before
    // the loop so a genuine paid tier is chosen, not the half-populated row
    // that happens to have a falsy basePrice.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getSKUs).mockResolvedValue([
      // p1: no basePrice (would have been "free" pre-fix; now skipped)
      sku({ uuid: 'a', name: 'docker-micro', providerUuid: 'p1', basePrice: undefined as unknown as SKU['basePrice'] }),
      // p2: 0.05 PWR/hour — the genuinely-cheapest priced provider
      sku({ uuid: 'b', name: 'docker-micro', providerUuid: 'p2', basePrice: { amount: '50000', denom: 'upwr' } }),
      // p3: 0.2 PWR/hour
      sku({ uuid: 'c', name: 'docker-micro', providerUuid: 'p3', basePrice: { amount: '200000', denom: 'upwr' } }),
    ]);
    const result = await resolveSkuTiers({
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
    });
    expect(result.tiers).toHaveLength(1);
    expect(result.tiers[0].providerUuid).toBe('p2');
    expect(result.tiers[0].skuUuid).toBe('b');
    expect(result.tiers[0].pricePerHour).toBeCloseTo(0.05);
    spy.mockRestore();
  });

  it('drops the spec entry with a "noPricedProvider" warning when ALL candidates lack basePrice, and does NOT also log "missingSpec" for the same name', async () => {
    // Pass-12 fix: the noPricedProvider branch claims `matchedSkuNames` before
    // `continue` so the missing-spec loop below doesn't fire a second,
    // misleading warning ("Chain SKU 'X' has no entry in PUBLIC_SKU_SPECS")
    // about the same SKU. One root cause = one warning.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getSKUs).mockResolvedValue([
      sku({ uuid: 'a', name: 'docker-micro', providerUuid: 'p1', basePrice: undefined as unknown as SKU['basePrice'] }),
      sku({ uuid: 'b', name: 'docker-micro', providerUuid: 'p2', basePrice: undefined as unknown as SKU['basePrice'] }),
    ]);
    const result = await resolveSkuTiers({
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
    });
    expect(result.tiers).toEqual([]);
    // logError prefixes the context to console.error — assert against the
    // first arg so it works whether the second arg is an Error or string.
    const calls = spy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes('noPricedProvider'))).toBe(true);
    // Cross-loop invariant: missingSpec must NOT fire for the same SKU name.
    // Pre-pass-12, the missing-spec loop saw `docker-micro` as unmatched
    // (matchedSkuNames was empty for it) and logged a duplicate warning.
    expect(calls.some((c) => c.includes('missingSpec'))).toBe(false);
    // Exactly one logError across the whole resolveSkuTiers run for this
    // scenario — the noPricedProvider one. Anything else means we
    // accidentally double-warned.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('still selects a genuine zero-price tier (basePrice.amount === "0") — regression catch', async () => {
    // The new filter checks for `!!basePrice` (object presence), NOT for a
    // truthy amount. A genuinely-free SKU has a basePrice object whose amount
    // is "0", so it survives the filter, hourlyPriceFromSku returns 0, and
    // the tier is selected correctly as the cheapest. Critical to distinguish
    // from the missing-basePrice case the fix is targeting.
    vi.mocked(getSKUs).mockResolvedValue([
      sku({ uuid: 'a', name: 'docker-micro', providerUuid: 'p1', basePrice: { amount: '0', denom: 'upwr' } }),
      sku({ uuid: 'b', name: 'docker-micro', providerUuid: 'p2', basePrice: { amount: '50000', denom: 'upwr' } }),
    ]);
    const result = await resolveSkuTiers({
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
    });
    expect(result.tiers).toHaveLength(1);
    // p1 wins because its amount is genuinely 0, not because basePrice is missing.
    expect(result.tiers[0].providerUuid).toBe('p1');
    expect(result.tiers[0].pricePerHour).toBe(0);
  });
});

describe('getCheapestTier', () => {
  it('returns the only tier in a single-element list', () => {
    const t = tier({ skuName: 'docker-micro', pricePerHour: 0.05 });
    expect(getCheapestTier([t])).toBe(t);
  });

  it('returns the cheapest when it is at the start', () => {
    const cheap = tier({ skuName: 'a', pricePerHour: 0.01 });
    const mid = tier({ skuName: 'b', pricePerHour: 0.1 });
    const exp = tier({ skuName: 'c', pricePerHour: 0.5 });
    expect(getCheapestTier([cheap, mid, exp])).toBe(cheap);
  });

  it('returns the cheapest when it is in the middle', () => {
    const exp = tier({ skuName: 'a', pricePerHour: 0.5 });
    const cheap = tier({ skuName: 'b', pricePerHour: 0.01 });
    const mid = tier({ skuName: 'c', pricePerHour: 0.1 });
    expect(getCheapestTier([exp, cheap, mid])).toBe(cheap);
  });

  it('returns the cheapest when it is at the end', () => {
    const exp = tier({ skuName: 'a', pricePerHour: 0.5 });
    const mid = tier({ skuName: 'b', pricePerHour: 0.1 });
    const cheap = tier({ skuName: 'c', pricePerHour: 0.01 });
    expect(getCheapestTier([exp, mid, cheap])).toBe(cheap);
  });

  it('tie-breaks by first occurrence', () => {
    const first = tier({ skuName: 'a', pricePerHour: 0.05 });
    const second = tier({ skuName: 'b', pricePerHour: 0.05 });
    const third = tier({ skuName: 'c', pricePerHour: 0.05 });
    expect(getCheapestTier([first, second, third])).toBe(first);
  });

  it('treats pricePerHour=0 as the cheapest', () => {
    const free = tier({ skuName: 'a', pricePerHour: 0 });
    const paid = tier({ skuName: 'b', pricePerHour: 0.01 });
    expect(getCheapestTier([paid, free])).toBe(free);
  });

  it('throws on empty input (callers must guard tiers.length === 0)', () => {
    expect(() => getCheapestTier([])).toThrow();
  });
});

describe('resolveSizeName', () => {
  const micro = tier({ skuName: 'docker-micro' });
  const small = tier({ skuName: 'docker-small' });
  const large = tier({ skuName: 'docker-large' });
  const tiers = [micro, small, large];

  it('matches a canonical SKU name exactly', () => {
    expect(resolveSizeName('docker-small', tiers)).toBe(small);
  });

  it('matches the docker- prefix backward-compat form', () => {
    expect(resolveSizeName('small', tiers)).toBe(small);
  });

  it('matches the suffix-only backward-compat form', () => {
    const gpu = tier({ skuName: 'gpu-medium' });
    const tiersWithGpu = [...tiers, gpu];
    expect(resolveSizeName('medium', tiersWithGpu)).toBe(gpu);
  });

  it('is case-insensitive on the input', () => {
    expect(resolveSizeName('Docker-Small', tiers)).toBe(small);
    expect(resolveSizeName('SMALL', tiers)).toBe(small);
  });

  it('is case-insensitive on the catalog SKU names too', () => {
    // Network-provided SKU names may not be lowercase. The docstring promises
    // case-insensitive lookup; without lowercasing `t.skuName` as well, a
    // request for 'small' against an uppercase 'Docker-Small' SKU would
    // silently miss all three fallbacks.
    const mixedMicro = tier({ skuName: 'Docker-Micro' });
    const mixedSmall = tier({ skuName: 'Docker-Small' });
    const mixedGpu = tier({ skuName: 'GPU-Large' });
    const mixedTiers = [mixedMicro, mixedSmall, mixedGpu];

    // canonical match
    expect(resolveSizeName('Docker-Micro', mixedTiers)).toBe(mixedMicro);
    expect(resolveSizeName('docker-micro', mixedTiers)).toBe(mixedMicro);
    // docker- prefix backward-compat against uppercase catalog
    expect(resolveSizeName('small', mixedTiers)).toBe(mixedSmall);
    expect(resolveSizeName('SMALL', mixedTiers)).toBe(mixedSmall);
    // suffix-only backward-compat against uppercase catalog
    expect(resolveSizeName('large', mixedTiers)).toBe(mixedGpu);
    expect(resolveSizeName('LARGE', mixedTiers)).toBe(mixedGpu);
  });

  it('returns null for unresolvable size', () => {
    expect(resolveSizeName('xxlarge', tiers)).toBeNull();
    expect(resolveSizeName('docker-xxlarge', tiers)).toBeNull();
  });

  it('returns null for empty tier list', () => {
    expect(resolveSizeName('micro', [])).toBeNull();
  });

  it('canonical match wins over docker- fallback', () => {
    // If a tier is literally named 'small' AND there's a 'docker-small',
    // the canonical-name match should win because it's tried first.
    const literalSmall = tier({ skuName: 'small' });
    const dockerSmall = tier({ skuName: 'docker-small' });
    expect(resolveSizeName('small', [dockerSmall, literalSmall])).toBe(literalSmall);
  });

  it('trims incidental surrounding whitespace before matching', () => {
    expect(resolveSizeName('  small  ', tiers)).toBe(small);
    expect(resolveSizeName(' docker-large ', tiers)).toBe(large);
  });
});

describe('resolveSizeOrCheapest', () => {
  const micro = tier({ skuName: 'docker-micro', pricePerHour: 0.036 });
  const small = tier({ skuName: 'docker-small', pricePerHour: 0.1 });
  const large = tier({ skuName: 'docker-large', pricePerHour: 0.5 });
  const tiers = [small, large, micro]; // intentionally not price-ordered

  it('returns null for an empty tier list', () => {
    expect(resolveSizeOrCheapest('micro', [])).toBeNull();
    expect(resolveSizeOrCheapest(undefined, [])).toBeNull();
  });

  it('returns the cheapest tier with cheapest-omitted when no size given', () => {
    expect(resolveSizeOrCheapest(undefined, tiers)).toEqual({ tier: micro, fallback: 'cheapest-omitted' });
  });

  it('returns the exact tier with exact when the size resolves', () => {
    expect(resolveSizeOrCheapest('small', tiers)).toEqual({ tier: small, fallback: 'exact' });
    expect(resolveSizeOrCheapest('docker-large', tiers)).toEqual({ tier: large, fallback: 'exact' });
  });

  it('falls back to cheapest with cheapest-unavailable + requested when the size is unknown', () => {
    expect(resolveSizeOrCheapest('xxlarge', tiers)).toEqual({
      tier: micro,
      fallback: 'cheapest-unavailable',
      requested: 'xxlarge',
    });
  });

  it('treats a whitespace-only size as omitted (cheapest-omitted, no note)', () => {
    expect(resolveSizeOrCheapest('   ', tiers)).toEqual({ tier: micro, fallback: 'cheapest-omitted' });
  });

  it('trims a padded valid size to an exact match', () => {
    expect(resolveSizeOrCheapest('  docker-large  ', tiers)).toEqual({ tier: large, fallback: 'exact' });
  });

  it('uses the trimmed value as `requested` when a padded size is unavailable', () => {
    expect(resolveSizeOrCheapest('  xxlarge  ', tiers)).toEqual({
      tier: micro,
      fallback: 'cheapest-unavailable',
      requested: 'xxlarge',
    });
  });
});

describe('formatTierSpecs', () => {
  it('formats sub-1-core, MB ram, and disk', () => {
    expect(formatTierSpecs(tier({ cores: 0.5, ramMB: 512, diskGB: 1 })))
      .toBe('0.5 vCPU · 512 MB RAM · 1 GB disk');
  });

  it('rolls MB ram up to whole GB', () => {
    expect(formatTierSpecs(tier({ cores: 1, ramMB: 1024, diskGB: 5 })))
      .toBe('1 vCPU · 1 GB RAM · 5 GB disk');
    expect(formatTierSpecs(tier({ cores: 4, ramMB: 4096, diskGB: 20 })))
      .toBe('4 vCPU · 4 GB RAM · 20 GB disk');
  });

  it('uses one decimal for non-whole GB ram', () => {
    expect(formatTierSpecs(tier({ cores: 2, ramMB: 1536, diskGB: 10 })))
      .toBe('2 vCPU · 1.5 GB RAM · 10 GB disk');
  });
});
