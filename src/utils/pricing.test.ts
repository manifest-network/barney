import { describe, it, expect } from 'vitest';
import { formatCostPerHour, isValidLeaseItem, calculateEstimatedCost } from './pricing';
import { Unit } from '../api/sku';
import type { SKU } from '../api/sku';
import type { LeaseItem } from '../api/billing';
import { DENOMS } from '../api/config';

function makeItem(amount: string, quantity: bigint | string, denom: string = DENOMS.PWR): LeaseItem {
  const q = typeof quantity === 'string' ? BigInt(parseInt(quantity, 10) || 0) : quantity;
  return { skuUuid: 'sku-1', quantity: q, lockedPrice: { amount, denom } };
}

describe('formatCostPerHour', () => {
  it('returns 0 for empty items array', () => {
    expect(formatCostPerHour([])).toBe('0.0000 tokens/hr');
  });

  it('calculates hourly cost from per-second rate', () => {
    // 10 upwr/sec * quantity 1 * 3600 = 36000 upwr/hr = 0.036 PWR/hr
    const items = [makeItem('10', 1n)];
    expect(formatCostPerHour(items)).toBe('0.0360 PWR/hr');
  });

  it('multiplies by quantity', () => {
    // 10 upwr/sec * quantity 3 * 3600 = 108000 upwr/hr = 0.108 PWR/hr
    const items = [makeItem('10', 3n)];
    expect(formatCostPerHour(items)).toBe('0.1080 PWR/hr');
  });

  it('sums across multiple items', () => {
    // (10 * 1 + 40 * 2) * 3600 = 90 * 3600 = 324000 upwr/hr = 0.324 PWR/hr
    const items = [makeItem('10', 1n), makeItem('40', 2n)];
    expect(formatCostPerHour(items)).toBe('0.3240 PWR/hr');
  });

  it('handles zero per-second rate', () => {
    const items = [makeItem('0', 5n)];
    expect(formatCostPerHour(items)).toBe('0.0000 PWR/hr');
  });

  it('handles zero quantity', () => {
    const items = [makeItem('10', 0n)];
    expect(formatCostPerHour(items)).toBe('0.0000 PWR/hr');
  });

  it('handles invalid quantity (0n) gracefully', () => {
    const items = [makeItem('10', 0n)];
    expect(formatCostPerHour(items)).toBe('0.0000 PWR/hr');
  });

  it('handles invalid amount string gracefully', () => {
    const items = [makeItem('not-a-number', 1n)];
    expect(formatCostPerHour(items)).toBe('0.0000 PWR/hr');
  });

  it('handles large values without losing precision via BigInt', () => {
    // 1_000_000_000 upwr/sec * quantity 1000 * 3600 = 3.6e15 upwr/hr
    // This exceeds Number.MAX_SAFE_INTEGER for intermediate multiplication
    // but BigInt keeps it exact. 3_600_000_000_000_000 / 1e6 = 3_600_000_000 PWR/hr
    const items = [makeItem('1000000000', 1000n)];
    expect(formatCostPerHour(items)).toBe('3600000000.0000 PWR/hr');
  });

  it('uses fallback metadata for unknown denom', () => {
    const items = [makeItem('1000000', 1n, 'uunknown')];
    // 1000000 * 1 * 3600 = 3_600_000_000 / 1e6 (default exponent) = 3600
    expect(formatCostPerHour(items)).toBe('3600.0000 tokens/hr');
  });

  it('uses MFX denom metadata when applicable', () => {
    // 10 umfx/sec * 1 * 3600 = 36000 / 1e6 = 0.036
    const items = [makeItem('10', 1n, DENOMS.MFX)];
    expect(formatCostPerHour(items)).toBe('0.0360 MFX/hr');
  });
});

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
      providerUuid: 'provider-1',
      name: 'Small VM',
      unit: Unit.UNIT_PER_HOUR,
      basePrice: { denom: DENOMS.PWR, amount: '1000000' }, // 1 PWR/hr
      metaHash: new Uint8Array(),
      active: true,
    },
    {
      uuid: 'sku-2',
      providerUuid: 'provider-1',
      name: 'Large VM',
      unit: Unit.UNIT_PER_HOUR,
      basePrice: { denom: DENOMS.PWR, amount: '5000000' }, // 5 PWR/hr
      metaHash: new Uint8Array(),
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
        providerUuid: 'provider-1',
        name: 'Invalid',
        unit: Unit.UNIT_PER_HOUR,
        basePrice: { denom: DENOMS.PWR, amount: 'not-a-number' },
        metaHash: new Uint8Array(),
        active: true,
      },
    ];
    const items = [{ skuUuid: 'sku-invalid', quantity: 1 }];
    expect(calculateEstimatedCost(items, skusWithInvalidPrice)).toBeNull();
  });
});
