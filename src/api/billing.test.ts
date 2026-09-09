import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LeaseState,
  leaseStateToString,
  leaseStateFromString,
  LEASE_STATE_MAP,
  LEASE_STATE_FILTERS,
  getLeasesByTenant,
  getLeasesByTenantPaginated,
  getBillingParams,
  getLease,
  getCreditAccount,
  getCreditEstimate,
} from './billing';

// ENG-536/537: billing reads go through the SDK read client. Typed methods
// (getLease, getLeasesByTenant, getBillingParams) + the `client.query` LCD
// drop-down for the credit family; not-found surfaces as a NOT_FOUND error
// (grpc code:5) classified by the real isNotFoundError.
const {
  mockGetBillingParams,
  mockGetLeasesByTenant,
  mockGetLease,
  mockCreditAccount,
  mockCreditAddress,
  mockCreditEstimate,
} = vi.hoisted(() => ({
  mockGetBillingParams: vi.fn(),
  mockGetLeasesByTenant: vi.fn(),
  mockGetLease: vi.fn(),
  mockCreditAccount: vi.fn(),
  mockCreditAddress: vi.fn(),
  mockCreditEstimate: vi.fn(),
}));

vi.mock('./readClient', () => ({
  getReadClient: vi.fn().mockResolvedValue({
    getBillingParams: (...a: unknown[]) => mockGetBillingParams(...a),
    getLeasesByTenant: (...a: unknown[]) => mockGetLeasesByTenant(...a),
    getLease: (...a: unknown[]) => mockGetLease(...a),
    query: {
      liftedinit: {
        billing: {
          v1: {
            creditAccount: (...a: unknown[]) => mockCreditAccount(...a),
            creditAddress: (...a: unknown[]) => mockCreditAddress(...a),
            creditEstimate: (...a: unknown[]) => mockCreditEstimate(...a),
          },
        },
      },
    },
  }),
}));

import { getReadClient } from './readClient';

/** A grpc-gateway NOT_FOUND envelope that the real isNotFoundError classifies (code:5). */
const notFound = () => Object.assign(new Error('not found'), { response: { data: { code: 5 } } });
/** A non-not-found failure (code:13 = INTERNAL). */
const internal = () => Object.assign(new Error('boom'), { response: { data: { code: 13 } } });

describe('leaseStateToString', () => {
  it('converts LEASE_STATE_ACTIVE to string', () => {
    const result = leaseStateToString(LeaseState.LEASE_STATE_ACTIVE);
    expect(typeof result).toBe('string');
    expect(result).toContain('ACTIVE');
  });

  it('converts LEASE_STATE_PENDING to string', () => {
    expect(leaseStateToString(LeaseState.LEASE_STATE_PENDING)).toContain('PENDING');
  });

  it('converts LEASE_STATE_CLOSED to string', () => {
    expect(leaseStateToString(LeaseState.LEASE_STATE_CLOSED)).toContain('CLOSED');
  });
});

describe('leaseStateFromString', () => {
  it('converts string back to enum value', () => {
    const str = leaseStateToString(LeaseState.LEASE_STATE_ACTIVE);
    expect(leaseStateFromString(str)).toBe(LeaseState.LEASE_STATE_ACTIVE);
  });

  it('roundtrips all states through to/from', () => {
    const states = [
      LeaseState.LEASE_STATE_PENDING,
      LeaseState.LEASE_STATE_ACTIVE,
      LeaseState.LEASE_STATE_CLOSED,
      LeaseState.LEASE_STATE_REJECTED,
      LeaseState.LEASE_STATE_EXPIRED,
    ];
    for (const state of states) {
      expect(leaseStateFromString(leaseStateToString(state))).toBe(state);
    }
  });
});

describe('LEASE_STATE_MAP', () => {
  it('maps all expected string keys to LeaseState values', () => {
    expect(LEASE_STATE_MAP['pending']).toBe(LeaseState.LEASE_STATE_PENDING);
    expect(LEASE_STATE_MAP['active']).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(LEASE_STATE_MAP['closed']).toBe(LeaseState.LEASE_STATE_CLOSED);
    expect(LEASE_STATE_MAP['rejected']).toBe(LeaseState.LEASE_STATE_REJECTED);
    expect(LEASE_STATE_MAP['expired']).toBe(LeaseState.LEASE_STATE_EXPIRED);
  });

  it('has exactly 5 entries', () => {
    expect(Object.keys(LEASE_STATE_MAP)).toHaveLength(5);
  });
});

describe('LEASE_STATE_FILTERS', () => {
  it('starts with "all"', () => {
    expect(LEASE_STATE_FILTERS[0]).toBe('all');
  });

  it('includes all state map keys', () => {
    for (const key of Object.keys(LEASE_STATE_MAP)) {
      expect(LEASE_STATE_FILTERS).toContain(key);
    }
  });

  it('has 6 entries (all + 5 states)', () => {
    expect(LEASE_STATE_FILTERS).toHaveLength(6);
  });
});

describe('getLeasesByTenant', () => {
  beforeEach(() => {
    mockGetLeasesByTenant.mockReset();
  });

  it('returns the complete inventory beyond the former 1000-lease cap', async () => {
    const leases = Array.from({ length: 1001 }, (_, index) => ({ uuid: `lease-${index}` }));
    mockGetLeasesByTenant.mockImplementation(({ offset, limit }) => Promise.resolve({
      leases: leases.slice(Number(offset), Number(offset + limit)),
      total: 1001n,
    }));

    expect(await getLeasesByTenant('addr1')).toEqual(leases);
    expect(mockGetLeasesByTenant).toHaveBeenCalledTimes(11);
    expect(mockGetLeasesByTenant).toHaveBeenLastCalledWith({
      tenant: 'addr1',
      stateFilter: LeaseState.LEASE_STATE_UNSPECIFIED,
      limit: 100n,
      offset: 1000n,
    });
  });

  it('advances by the returned count when the provider caps pages below the requested limit', async () => {
    const first = [{ uuid: 'lease-1' }, { uuid: 'lease-2' }];
    const last = [{ uuid: 'lease-3' }];
    mockGetLeasesByTenant
      .mockResolvedValueOnce({ leases: first, total: 3n })
      .mockResolvedValueOnce({ leases: last, total: 3n });

    expect(await getLeasesByTenant('addr1', LeaseState.LEASE_STATE_ACTIVE)).toEqual([...first, ...last]);
    expect(mockGetLeasesByTenant).toHaveBeenNthCalledWith(2, {
      tenant: 'addr1',
      stateFilter: LeaseState.LEASE_STATE_ACTIVE,
      limit: 100n,
      offset: 2n,
    });
  });

  it('returns an empty inventory when no leases exist', async () => {
    mockGetLeasesByTenant.mockResolvedValue({ leases: [], total: 0n });
    expect(await getLeasesByTenant('addr1')).toEqual([]);
    expect(mockGetLeasesByTenant).toHaveBeenCalledTimes(1);
  });

  it('continues through short pages until empty when pagination totals are unavailable', async () => {
    mockGetLeasesByTenant
      .mockResolvedValueOnce({ leases: [{ uuid: 'lease-1' }], total: 0n })
      .mockResolvedValueOnce({ leases: [{ uuid: 'lease-2' }], total: 0n })
      .mockResolvedValueOnce({ leases: [], total: 0n });

    expect(await getLeasesByTenant('addr1')).toEqual([{ uuid: 'lease-1' }, { uuid: 'lease-2' }]);
    expect(mockGetLeasesByTenant.mock.calls.map(([params]) => params.offset)).toEqual([0n, 1n, 2n]);
  });

  it('fails instead of looping or returning a partial inventory when the provider repeats a page', async () => {
    mockGetLeasesByTenant.mockResolvedValue({ leases: [{ uuid: 'lease-1' }], total: 0n });

    await expect(getLeasesByTenant('addr1')).rejects.toThrow('duplicate lease');
    expect(mockGetLeasesByTenant).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty page before the reported total is reached', async () => {
    mockGetLeasesByTenant
      .mockResolvedValueOnce({ leases: [{ uuid: 'lease-1' }], total: 2n })
      .mockResolvedValueOnce({ leases: [], total: 2n });

    await expect(getLeasesByTenant('addr1')).rejects.toThrow('before all leases were returned');
  });

  it('rejects changing totals instead of accepting an inconsistent inventory', async () => {
    mockGetLeasesByTenant
      .mockResolvedValueOnce({ leases: [{ uuid: 'lease-1' }], total: 2n })
      .mockResolvedValueOnce({ leases: [{ uuid: 'lease-2' }], total: 3n });

    await expect(getLeasesByTenant('addr1')).rejects.toThrow('total changed');
  });

  it.each([-1n, undefined, 1])('rejects an invalid total (%s)', async (total) => {
    mockGetLeasesByTenant.mockResolvedValue({ leases: [], total });
    await expect(getLeasesByTenant('addr1')).rejects.toThrow('invalid pagination total');
  });

  it('rejects a page containing more leases than its reported total', async () => {
    mockGetLeasesByTenant.mockResolvedValue({
      leases: [{ uuid: 'lease-1' }, { uuid: 'lease-2' }],
      total: 1n,
    });
    await expect(getLeasesByTenant('addr1')).rejects.toThrow('more leases than its total');
  });

  it('propagates later page failures instead of returning a partial inventory', async () => {
    mockGetLeasesByTenant
      .mockResolvedValueOnce({ leases: [{ uuid: 'lease-1' }], total: 2n })
      .mockRejectedValueOnce(new Error('network unavailable'));

    await expect(getLeasesByTenant('addr1')).rejects.toThrow('network unavailable');
  });
});

describe('getLeasesByTenantPaginated', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes pagination params (as bigints) to the typed read', async () => {
    mockGetLeasesByTenant.mockResolvedValue({
      leases: [{ uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, tenant: 'addr1', items: [] }],
      total: 1n,
    });

    const result = await getLeasesByTenantPaginated('addr1', {
      stateFilter: LeaseState.LEASE_STATE_ACTIVE,
      limit: 5,
      offset: 10,
      reverse: true,
    });

    expect(mockGetLeasesByTenant).toHaveBeenCalledWith({
      tenant: 'addr1',
      stateFilter: LeaseState.LEASE_STATE_ACTIVE,
      limit: 5n,
      offset: 10n,
      reverse: true,
    });
    expect(result.leases).toHaveLength(1);
    expect(result.pagination?.total).toBe(1n);
  });

  it('defaults to unspecified state filter', async () => {
    mockGetLeasesByTenant.mockResolvedValue({ leases: [], total: 0n });
    await getLeasesByTenantPaginated('addr1');
    expect(mockGetLeasesByTenant).toHaveBeenCalledWith(
      expect.objectContaining({ stateFilter: LeaseState.LEASE_STATE_UNSPECIFIED }),
    );
  });
});

describe('getLease (read-client passthrough)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the lease from the read client', async () => {
    const lease = { uuid: 'lu1' };
    mockGetLease.mockResolvedValue(lease);
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(await getLease(uuid)).toBe(lease);
    expect(mockGetLease).toHaveBeenCalledWith(uuid);
  });

  it('returns null when the read client reports the lease absent', async () => {
    mockGetLease.mockResolvedValue(null);
    expect(await getLease('550e8400-e29b-41d4-a716-446655440000')).toBeNull();
  });
});

describe('getCreditAccount (client.query + isNotFoundError)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the account on hit', async () => {
    const acct = {
      creditAccount: {
        tenant: 'addr1',
        creditAddress: 'credit-addr',
        activeLeaseCount: 1n,
        pendingLeaseCount: 0n,
        reservedAmounts: [],
      },
      balances: [],
      availableBalances: [],
    };
    mockCreditAccount.mockResolvedValue(acct);
    expect(await getCreditAccount('addr1')).toBe(acct);
    // Happy path issues a single query — the creditAddress lookup only runs on
    // the NOT_FOUND cold-start branch.
    expect(mockCreditAddress).not.toHaveBeenCalled();
  });

  it('synthesizes a zero-account when the chain reports NOT_FOUND', async () => {
    mockCreditAddress.mockResolvedValue({ creditAddress: 'credit-addr' });
    mockCreditAccount.mockRejectedValue(notFound());
    const result = await getCreditAccount('addr1');
    expect(result.creditAccount.creditAddress).toBe('credit-addr');
    expect(result.creditAccount.activeLeaseCount).toBe(0n);
    expect(result.balances).toEqual([]);
    expect(mockCreditAddress).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-not-found failure', async () => {
    mockCreditAddress.mockResolvedValue({ creditAddress: 'credit-addr' });
    mockCreditAccount.mockRejectedValue(internal());
    await expect(getCreditAccount('addr1')).rejects.toThrow('boom');
  });
});

describe('getCreditEstimate (client.query + isNotFoundError)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null on NOT_FOUND', async () => {
    mockCreditEstimate.mockRejectedValue(notFound());
    expect(await getCreditEstimate('addr1')).toBeNull();
  });

  it('returns the estimate on hit', async () => {
    const est = { totalRatePerSecond: '1', estimatedDurationSeconds: 100n };
    mockCreditEstimate.mockResolvedValue(est);
    expect(await getCreditEstimate('addr1')).toBe(est);
  });

  it('rethrows a non-not-found failure', async () => {
    mockCreditEstimate.mockRejectedValue(internal());
    await expect(getCreditEstimate('addr1')).rejects.toThrow('boom');
  });
});

describe('getBillingParams (read-client delegation)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to the read client and returns its Params', async () => {
    const sentinel = { creditDenoms: ['upwr'] } as unknown as Awaited<
      ReturnType<typeof getBillingParams>
    >;
    mockGetBillingParams.mockResolvedValue(sentinel);

    const result = await getBillingParams();

    expect(result).toBe(sentinel);
    expect(mockGetBillingParams).toHaveBeenCalledTimes(1);
    expect(getReadClient).toHaveBeenCalledTimes(1);
  });
});
