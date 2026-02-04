import { describe, it, expect } from 'vitest';
import { resolveSkuItems } from './transactions';

const UUID_A = '019beb87-09de-7000-beef-ae733e73ff23';
const UUID_B = '019beb87-09de-7000-beef-ae733e73ff24';

const skuList = [
  { uuid: UUID_A, name: 'GPU-A100', providerUuid: 'provider-1' },
  { uuid: UUID_B, name: 'CPU-Basic', providerUuid: 'provider-2' },
];

describe('resolveSkuItems', () => {
  it('items with sku_uuid pass through unchanged', () => {
    const result = resolveSkuItems(
      [{ sku_uuid: UUID_A, quantity: 2 }],
      undefined
    );
    expect(result).toEqual({ items: [{ sku_uuid: UUID_A, quantity: 2 }] });
  });

  it('resolves sku_name to sku_uuid via case-insensitive match', () => {
    const result = resolveSkuItems(
      [{ sku_name: 'gpu-a100', quantity: 1 }],
      skuList
    );
    expect(result).toEqual({ items: [{ sku_uuid: UUID_A, quantity: 1 }] });
  });

  it('returns error when name not found in SKU list', () => {
    const result = resolveSkuItems(
      [{ sku_name: 'NonExistent', quantity: 1 }],
      skuList
    );
    expect(result.error).toBeDefined();
    expect(result.error).toContain('No SKU found with name "NonExistent"');
  });

  it('returns error when name matches multiple SKUs (ambiguous)', () => {
    const ambiguousList = [
      { uuid: UUID_A, name: 'GPU', providerUuid: 'provider-1' },
      { uuid: UUID_B, name: 'GPU', providerUuid: 'provider-2' },
    ];
    const result = resolveSkuItems(
      [{ sku_name: 'GPU', quantity: 1 }],
      ambiguousList
    );
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Multiple SKUs found');
    expect(result.error).toContain(UUID_A);
    expect(result.error).toContain(UUID_B);
  });

  it('returns error for invalid UUID format', () => {
    const result = resolveSkuItems(
      [{ sku_uuid: 'not-a-valid-uuid', quantity: 1 }],
      undefined
    );
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Invalid SKU UUID format');
  });

  it('handles mixed name + uuid items in same array', () => {
    const result = resolveSkuItems(
      [
        { sku_uuid: UUID_A, quantity: 1 },
        { sku_name: 'CPU-Basic', quantity: 3 },
      ],
      skuList
    );
    expect(result).toEqual({
      items: [
        { sku_uuid: UUID_A, quantity: 1 },
        { sku_uuid: UUID_B, quantity: 3 },
      ],
    });
  });

  it('when both sku_uuid and sku_name present, sku_uuid takes priority', () => {
    const result = resolveSkuItems(
      [{ sku_uuid: UUID_A, sku_name: 'CPU-Basic', quantity: 1 }],
      skuList
    );
    expect(result).toEqual({ items: [{ sku_uuid: UUID_A, quantity: 1 }] });
  });

  it('returns error when allSKUs is undefined but name resolution needed', () => {
    const result = resolveSkuItems(
      [{ sku_name: 'GPU-A100', quantity: 1 }],
      undefined
    );
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Failed to fetch SKU list');
  });
});
