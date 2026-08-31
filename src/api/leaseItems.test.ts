import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getLeaseItemsForLease } from './leaseItems';
import * as billing from './billing';

vi.mock('./billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./billing')>();
  return {
    ...actual,
    getLease: vi.fn(),
  };
});

describe('getLeaseItemsForLease', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when lease is not found', async () => {
    vi.mocked(billing.getLease).mockResolvedValue(null);
    const items = await getLeaseItemsForLease('uuid-1');
    expect(items).toBeNull();
  });

  it('returns the lease items when present', async () => {
    const items = [
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '10', denom: 'upwr' }, serviceName: 'web', customDomain: 'app.example.com' },
      { skuUuid: 'sku-2', quantity: 1n, lockedPrice: { amount: '20', denom: 'upwr' }, serviceName: 'db', customDomain: '' },
    ];
    vi.mocked(billing.getLease).mockResolvedValue({
      uuid: 'uuid-1',
      tenant: 'tenant-addr',
      providerUuid: 'provider-1',
      items,
    } as unknown as Awaited<ReturnType<typeof billing.getLease>>);
    expect(await getLeaseItemsForLease('uuid-1')).toEqual(items);
  });

  it('returns empty array when lease has no items field', async () => {
    vi.mocked(billing.getLease).mockResolvedValue({
      uuid: 'uuid-1',
      tenant: 'tenant-addr',
    } as unknown as Awaited<ReturnType<typeof billing.getLease>>);
    expect(await getLeaseItemsForLease('uuid-1')).toEqual([]);
  });
});
