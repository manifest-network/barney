import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetSKUs, mockGetProviders } = vi.hoisted(() => ({
  mockGetSKUs: vi.fn(),
  mockGetProviders: vi.fn(),
}));

vi.mock('./readClient', () => ({
  getReadClient: vi.fn().mockResolvedValue({
    getSKUs: (...a: unknown[]) => mockGetSKUs(...a),
    getProviders: (...a: unknown[]) => mockGetProviders(...a),
  }),
}));

import { getSKUs, getProviders, Unit } from './sku';
import type { SKU } from './sku';
import { hourlyPriceFromSku } from './skuTiers';

beforeEach(() => {
  mockGetSKUs.mockReset();
  mockGetProviders.mockReset();
});

describe('getSKUs (read-client delegation)', () => {
  it('calls the read client with { activeOnly }', async () => {
    mockGetSKUs.mockResolvedValue([]);
    await getSKUs(true);
    expect(mockGetSKUs).toHaveBeenCalledWith({ activeOnly: true });
  });

  it('preserves the NUMERIC unit enum (no fixSKUEnums re-map) so per-day prices divide by 24', async () => {
    const perDay: SKU = {
      uuid: 'sku-1',
      providerUuid: 'prov-1',
      name: 'docker-micro',
      unit: Unit.UNIT_PER_DAY,                          // numeric, not "UNIT_PER_DAY"
      basePrice: { amount: '24000000', denom: 'upwr' }, // 24 PWR/day
      metaHash: new Uint8Array(),
      active: true,
    } as SKU;
    mockGetSKUs.mockResolvedValue([perDay]);

    const [sku] = await getSKUs(true);
    expect(sku.unit).toBe(Unit.UNIT_PER_DAY);
    expect(hourlyPriceFromSku(sku)).toBeCloseTo(1.0); // 24/day ÷ 24 = 1/hr
  });
});

describe('getProviders (read-client delegation)', () => {
  it('calls the read client with { activeOnly } and returns the list', async () => {
    mockGetProviders.mockResolvedValue([{ uuid: 'p1', apiUrl: 'https://p1' }]);
    const providers = await getProviders(true);
    expect(mockGetProviders).toHaveBeenCalledWith({ activeOnly: true });
    expect(providers).toHaveLength(1);
    expect(providers[0].uuid).toBe('p1');
  });
});
