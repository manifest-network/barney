import { describe, it, expect } from 'vitest';
import { isValidLeaseItem, calculateEstimatedCost } from './pricing';
import { Unit } from '../api/sku';
import type { SKU } from '../api/sku';
import { DENOMS } from '../api/config';

describe('isValidLeaseItem', () => {
  it('returns true for valid item with skuUuid and positive quantity', () => {
    expect(isValidLeaseItem({ skuUuid: 'uuid-123', quantity: 1 })).toBe(true);
    expect(isValidLeaseItem({ skuUuid: 'uuid-123', quantity: 100 })).toBe(true);
  });

  it('returns false for empty skuUuid', () => {
    expect(isValidLeaseItem({ skuUuid: '', quantity: 1 })).toBe(false);
  });

  it('returns false for zero quantity', () => {
    expect(isValidLeaseItem({ skuUuid: 'uuid-123', quantity: 0 })).toBe(false);
  });

  it('returns false for negative quantity', () => {
    expect(isValidLeaseItem({ skuUuid: 'uuid-123', quantity: -1 })).toBe(false);
  });

  it('returns false for non-integer quantity', () => {
    expect(isValidLeaseItem({ skuUuid: 'uuid-123', quantity: 1.5 })).toBe(false);
  });

  it('returns false for NaN quantity', () => {
    expect(isValidLeaseItem({ skuUuid: 'uuid-123', quantity: NaN })).toBe(false);
  });
});

describe('calculateEstimatedCost', () => {
  const mockSKUs: SKU[] = [
    {
      uuid: 'sku-1',
      provider_uuid: 'provider-1',
      name: 'Small VM',
      unit: Unit.UNIT_PER_HOUR,
      base_price: { denom: DENOMS.PWR, amount: '1000000' }, // 1 PWR/hr
      meta_hash: '',
      active: true,
    },
    {
      uuid: 'sku-2',
      provider_uuid: 'provider-1',
      name: 'Large VM',
      unit: Unit.UNIT_PER_HOUR,
      base_price: { denom: DENOMS.PWR, amount: '5000000' }, // 5 PWR/hr
      meta_hash: '',
      active: true,
    },
  ];

  it('returns null for empty items array', () => {
    expect(calculateEstimatedCost([], mockSKUs)).toBeNull();
  });

  it('returns null for items with no matching SKU', () => {
    const items = [{ skuUuid: 'non-existent', quantity: 1 }];
    expect(calculateEstimatedCost(items, mockSKUs)).toBeNull();
  });

  it('returns null for items with empty skuUuid', () => {
    const items = [{ skuUuid: '', quantity: 1 }];
    expect(calculateEstimatedCost(items, mockSKUs)).toBeNull();
  });

  it('calculates cost for single item', () => {
    const items = [{ skuUuid: 'sku-1', quantity: 1 }];
    const result = calculateEstimatedCost(items, mockSKUs);
    expect(result).toContain('1');
    expect(result).toContain('PWR');
    expect(result).toContain('/hr');
  });

  it('calculates cost for multiple quantities', () => {
    const items = [{ skuUuid: 'sku-1', quantity: 3 }];
    const result = calculateEstimatedCost(items, mockSKUs);
    expect(result).toContain('3');
    expect(result).toContain('PWR');
  });

  it('calculates cost for multiple items', () => {
    const items = [
      { skuUuid: 'sku-1', quantity: 1 }, // 1 PWR
      { skuUuid: 'sku-2', quantity: 2 }, // 10 PWR
    ];
    const result = calculateEstimatedCost(items, mockSKUs);
    // Total: 11 PWR
    expect(result).toContain('11');
    expect(result).toContain('PWR');
  });

  it('handles mixed valid and invalid items', () => {
    const items = [
      { skuUuid: 'sku-1', quantity: 1 },
      { skuUuid: 'non-existent', quantity: 1 },
    ];
    const result = calculateEstimatedCost(items, mockSKUs);
    expect(result).toContain('1');
    expect(result).toContain('PWR');
  });

  it('returns null when all items have invalid SKUs', () => {
    const items = [
      { skuUuid: 'invalid-1', quantity: 1 },
      { skuUuid: 'invalid-2', quantity: 1 },
    ];
    expect(calculateEstimatedCost(items, mockSKUs)).toBeNull();
  });

  it('handles SKUs with invalid price amounts gracefully', () => {
    const skusWithInvalidPrice: SKU[] = [
      {
        uuid: 'sku-invalid',
        provider_uuid: 'provider-1',
        name: 'Invalid',
        unit: Unit.UNIT_PER_HOUR,
        base_price: { denom: DENOMS.PWR, amount: 'not-a-number' },
        meta_hash: '',
        active: true,
      },
    ];
    const items = [{ skuUuid: 'sku-invalid', quantity: 1 }];
    expect(calculateEstimatedCost(items, skusWithInvalidPrice)).toBeNull();
  });
});
