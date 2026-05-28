import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hourlyPriceFromSku, resolveSkuTiers } from './skuTiers';
import { Unit } from './sku';
import type { SKU } from './sku';

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
});
