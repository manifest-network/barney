import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LeaseState,
  leaseStateToString,
  leaseStateFromString,
  LEASE_STATE_MAP,
  LEASE_STATE_FILTERS,
  getLeasesByTenantPaginated,
} from './billing';

vi.mock('./queryClient', () => {
  const mockLeasesByTenant = vi.fn();
  return {
    getQueryClient: vi.fn().mockResolvedValue({
      liftedinit: {
        billing: {
          v1: {
            leasesByTenant: mockLeasesByTenant,
          },
        },
      },
    }),
    lcdConvert: vi.fn((data) => data),
    queryWithNotFound: vi.fn(),
    fixEnumField: vi.fn((obj) => obj),
  };
});

import { getQueryClient, lcdConvert } from './queryClient';

describe('leaseStateToString', () => {
  it('converts LEASE_STATE_ACTIVE to string', () => {
    const result = leaseStateToString(LeaseState.LEASE_STATE_ACTIVE);
    expect(typeof result).toBe('string');
    expect(result).toContain('ACTIVE');
  });

  it('converts LEASE_STATE_PENDING to string', () => {
    const result = leaseStateToString(LeaseState.LEASE_STATE_PENDING);
    expect(result).toContain('PENDING');
  });

  it('converts LEASE_STATE_CLOSED to string', () => {
    const result = leaseStateToString(LeaseState.LEASE_STATE_CLOSED);
    expect(result).toContain('CLOSED');
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

describe('getLeasesByTenantPaginated', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes pagination params to LCD client', async () => {
    const mockLease = {
      uuid: 'lease-1',
      state: LeaseState.LEASE_STATE_ACTIVE,
      tenant: 'addr1',
      items: [],
      createdAt: '2024-01-01T00:00:00Z',
    };
    const mockResponse = {
      leases: [mockLease],
      pagination: { total: 1n, nextKey: new Uint8Array() },
    };

    const client = await vi.mocked(getQueryClient)();
    vi.mocked(client.liftedinit.billing.v1.leasesByTenant).mockResolvedValue(mockResponse as any);
    vi.mocked(lcdConvert).mockReturnValue(mockResponse as any);

    const result = await getLeasesByTenantPaginated('addr1', {
      stateFilter: LeaseState.LEASE_STATE_ACTIVE,
      limit: 5,
      offset: 10,
    });

    expect(client.liftedinit.billing.v1.leasesByTenant).toHaveBeenCalledWith({
      tenant: 'addr1',
      stateFilter: LeaseState.LEASE_STATE_ACTIVE,
      pagination: expect.objectContaining({
        limit: 5n,
        offset: 10n,
        countTotal: true,
      }),
    });
    expect(result.leases).toHaveLength(1);
    expect(result.pagination).toBeDefined();
  });

  it('defaults to unspecified state filter', async () => {
    const mockResponse = { leases: [], pagination: undefined };
    const client = await vi.mocked(getQueryClient)();
    vi.mocked(client.liftedinit.billing.v1.leasesByTenant).mockResolvedValue(mockResponse as any);
    vi.mocked(lcdConvert).mockReturnValue(mockResponse as any);

    await getLeasesByTenantPaginated('addr1');

    expect(client.liftedinit.billing.v1.leasesByTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        stateFilter: LeaseState.LEASE_STATE_UNSPECIFIED,
      })
    );
  });
});
