import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeLeaseStateFilter, executeQuery } from './queries';
import { LeaseState } from '../../api/billing';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';

// Mock all external API modules
vi.mock('../../api/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/billing')>();
  return {
    ...actual,
    getCreditAccount: vi.fn(),
    getCreditEstimate: vi.fn(),
    getLeasesByTenant: vi.fn(),
    getWithdrawableAmount: vi.fn(),
  };
});

vi.mock('../../api/sku', () => ({
  getProviders: vi.fn(),
  getSKUs: vi.fn(),
  getSKUsByProvider: vi.fn(),
}));

vi.mock('../../api/bank', () => ({
  getAllBalances: vi.fn(),
}));

vi.mock('@manifest-network/manifest-mcp-browser', () => ({
  cosmosQuery: vi.fn(),
}));

import { getCreditAccount, getCreditEstimate, getLeasesByTenant, getWithdrawableAmount } from '../../api/billing';
import { getProviders, getSKUs, getSKUsByProvider } from '../../api/sku';
import { getAllBalances } from '../../api/bank';
import { cosmosQuery } from '@manifest-network/manifest-mcp-browser';

const mockGetAllBalances = vi.mocked(getAllBalances);
const mockGetCreditAccount = vi.mocked(getCreditAccount);
const mockGetCreditEstimate = vi.mocked(getCreditEstimate);
const mockGetLeasesByTenant = vi.mocked(getLeasesByTenant);
const mockGetWithdrawableAmount = vi.mocked(getWithdrawableAmount);
const mockGetProviders = vi.mocked(getProviders);
const mockGetSKUs = vi.mocked(getSKUs);
const mockGetSKUsByProvider = vi.mocked(getSKUsByProvider);
const mockCosmosQuery = vi.mocked(cosmosQuery);

const ADDRESS = 'manifest1abc';
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const CLIENT_MANAGER = {} as CosmosClientManager;

describe('normalizeLeaseStateFilter', () => {
  it('undefined input returns state: undefined', () => {
    const result = normalizeLeaseStateFilter(undefined);
    expect(result).toEqual({ state: undefined });
  });

  it('"all" returns state: undefined (case insensitive)', () => {
    expect(normalizeLeaseStateFilter('all')).toEqual({ state: undefined });
    expect(normalizeLeaseStateFilter('ALL')).toEqual({ state: undefined });
    expect(normalizeLeaseStateFilter('All')).toEqual({ state: undefined });
  });

  it('"active" maps to LEASE_STATE_ACTIVE', () => {
    const result = normalizeLeaseStateFilter('active');
    expect(result).toEqual({ state: LeaseState.LEASE_STATE_ACTIVE });
  });

  it('"pending" maps to LEASE_STATE_PENDING (case insensitive)', () => {
    expect(normalizeLeaseStateFilter('pending')).toEqual({ state: LeaseState.LEASE_STATE_PENDING });
    expect(normalizeLeaseStateFilter('PENDING')).toEqual({ state: LeaseState.LEASE_STATE_PENDING });
  });

  it('"closed" maps to LEASE_STATE_CLOSED', () => {
    const result = normalizeLeaseStateFilter('closed');
    expect(result).toEqual({ state: LeaseState.LEASE_STATE_CLOSED });
  });

  it('"rejected" maps to LEASE_STATE_REJECTED', () => {
    const result = normalizeLeaseStateFilter('rejected');
    expect(result).toEqual({ state: LeaseState.LEASE_STATE_REJECTED });
  });

  it('"expired" maps to LEASE_STATE_EXPIRED', () => {
    const result = normalizeLeaseStateFilter('expired');
    expect(result).toEqual({ state: LeaseState.LEASE_STATE_EXPIRED });
  });

  it('invalid filter returns error', () => {
    const result = normalizeLeaseStateFilter('nonexistent');
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Invalid state filter');
    expect(result.error).toContain('nonexistent');
  });

  it('empty string returns state: undefined', () => {
    const result = normalizeLeaseStateFilter('');
    expect(result).toEqual({ state: undefined });
  });
});

describe('executeQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for unknown tool', async () => {
    const result = await executeQuery('nonexistent_tool', {}, CLIENT_MANAGER, ADDRESS);
    expect(result).toBeNull();
  });

  // --- get_balance ---

  describe('get_balance', () => {
    it('returns error when wallet not connected', async () => {
      const result = await executeQuery('get_balance', {}, CLIENT_MANAGER, undefined);
      expect(result?.success).toBe(false);
      expect(result?.error).toContain('Wallet not connected');
    });

    it('returns balances and credit account', async () => {
      const balances = [{ denom: 'umfx', amount: '1000000' }];
      const creditAccount = {
        creditAccount: {
          creditAddress: 'manifest1credit',
          activeLeaseCount: 2n,
          pendingLeaseCount: 1n,
          tenant: ADDRESS,
        },
        balances: [{ denom: 'umfx', amount: '500000' }],
      };

      mockGetAllBalances.mockResolvedValue(balances);
      mockGetCreditAccount.mockResolvedValue(creditAccount as any);

      const result = await executeQuery('get_balance', {}, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(true);
      expect(result?.data).toEqual({
        walletBalances: balances,
        creditAccount: {
          creditAddress: 'manifest1credit',
          balance: creditAccount.balances,
          activeLeaseCount: '2',
          pendingLeaseCount: '1',
        },
      });
    });

    it('returns null credit account when query fails', async () => {
      mockGetAllBalances.mockResolvedValue([]);
      mockGetCreditAccount.mockRejectedValue(new Error('not found'));

      const result = await executeQuery('get_balance', {}, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(true);
      expect(result?.data).toEqual({
        walletBalances: [],
        creditAccount: null,
      });
    });
  });

  // --- get_leases ---

  describe('get_leases', () => {
    it('returns error when wallet not connected', async () => {
      const result = await executeQuery('get_leases', {}, CLIENT_MANAGER, undefined);
      expect(result?.success).toBe(false);
      expect(result?.error).toContain('Wallet not connected');
    });

    it('returns leases without state filter', async () => {
      const leases = [{ uuid: 'lease-1' }, { uuid: 'lease-2' }];
      mockGetLeasesByTenant.mockResolvedValue(leases as any);

      const result = await executeQuery('get_leases', {}, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(true);
      expect(result?.data).toEqual({ leases, count: 2 });
      expect(mockGetLeasesByTenant).toHaveBeenCalledWith(ADDRESS, undefined);
    });

    it('returns leases with state filter', async () => {
      mockGetLeasesByTenant.mockResolvedValue([]);

      const result = await executeQuery('get_leases', { state: 'active' }, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(true);
      expect(mockGetLeasesByTenant).toHaveBeenCalledWith(ADDRESS, LeaseState.LEASE_STATE_ACTIVE);
    });

    it('returns error for invalid state filter', async () => {
      const result = await executeQuery('get_leases', { state: 'bogus' }, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(false);
      expect(result?.error).toContain('Invalid state filter');
    });
  });

  // --- get_providers ---

  describe('get_providers', () => {
    it('returns providers', async () => {
      const providers = [{ uuid: 'p1' }];
      mockGetProviders.mockResolvedValue(providers as any);

      const result = await executeQuery('get_providers', {}, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(true);
      expect(result?.data).toEqual({ providers, count: 1 });
      expect(mockGetProviders).toHaveBeenCalledWith(false);
    });

    it('passes active_only flag', async () => {
      mockGetProviders.mockResolvedValue([]);

      await executeQuery('get_providers', { active_only: true }, CLIENT_MANAGER, ADDRESS);
      expect(mockGetProviders).toHaveBeenCalledWith(true);
    });
  });

  // --- get_skus ---

  describe('get_skus', () => {
    it('returns all SKUs when no provider_uuid', async () => {
      const skus = [{ uuid: 's1' }];
      mockGetSKUs.mockResolvedValue(skus as any);

      const result = await executeQuery('get_skus', {}, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(true);
      expect(result?.data).toEqual({ skus, count: 1 });
      expect(mockGetSKUs).toHaveBeenCalledWith(false);
    });

    it('returns SKUs by provider when provider_uuid given', async () => {
      const skus = [{ uuid: 's1' }];
      mockGetSKUsByProvider.mockResolvedValue(skus as any);

      const result = await executeQuery('get_skus', { provider_uuid: VALID_UUID }, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(true);
      expect(result?.data).toEqual({ skus, count: 1 });
      expect(mockGetSKUsByProvider).toHaveBeenCalledWith(VALID_UUID, false);
    });

    it('returns error for invalid provider_uuid', async () => {
      const result = await executeQuery('get_skus', { provider_uuid: 'bad' }, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(false);
      expect(result?.error).toContain('Invalid provider_uuid format');
    });

    it('passes active_only flag to getSKUsByProvider', async () => {
      mockGetSKUsByProvider.mockResolvedValue([]);

      await executeQuery('get_skus', { provider_uuid: VALID_UUID, active_only: true }, CLIENT_MANAGER, ADDRESS);
      expect(mockGetSKUsByProvider).toHaveBeenCalledWith(VALID_UUID, true);
    });
  });

  // --- get_credit_estimate ---

  describe('get_credit_estimate', () => {
    it('returns error when wallet not connected', async () => {
      const result = await executeQuery('get_credit_estimate', {}, CLIENT_MANAGER, undefined);
      expect(result?.success).toBe(false);
      expect(result?.error).toContain('Wallet not connected');
    });

    it('returns message when no estimate available', async () => {
      mockGetCreditEstimate.mockResolvedValue(null);

      const result = await executeQuery('get_credit_estimate', {}, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(true);
      expect(result?.data).toEqual({ message: 'No active credit account or leases' });
    });

    it('returns formatted estimate', async () => {
      mockGetCreditEstimate.mockResolvedValue({
        currentBalance: [{ denom: 'umfx', amount: '10000000' }],
        totalRatePerSecond: [{ denom: 'umfx', amount: '1' }],
        estimatedDurationSeconds: 86400n,
        activeLeaseCount: 2n,
      } as any);

      const result = await executeQuery('get_credit_estimate', {}, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(true);
      expect(result?.data).toEqual({
        currentBalance: [{ denom: 'umfx', amount: '10000000' }],
        burnRatePerSecond: [{ denom: 'umfx', amount: '1' }],
        estimatedDurationSeconds: '86400',
        remainingHours: 24,
        remainingDays: 1,
        activeLeaseCount: '2',
      });
    });
  });

  // --- get_withdrawable ---

  describe('get_withdrawable', () => {
    it('returns error when lease_uuid is missing', async () => {
      const result = await executeQuery('get_withdrawable', {}, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(false);
      expect(result?.error).toContain('lease_uuid is required');
    });

    it('returns error for invalid UUID format', async () => {
      const result = await executeQuery('get_withdrawable', { lease_uuid: 'bad' }, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(false);
      expect(result?.error).toContain('Invalid lease_uuid format');
    });

    it('returns withdrawable amounts', async () => {
      const amounts = [{ denom: 'umfx', amount: '500000' }];
      mockGetWithdrawableAmount.mockResolvedValue(amounts);

      const result = await executeQuery('get_withdrawable', { lease_uuid: VALID_UUID }, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(true);
      expect(result?.data).toEqual({ leaseUuid: VALID_UUID, withdrawableAmounts: amounts });
    });
  });

  // --- cosmos_query ---

  describe('cosmos_query', () => {
    it('returns error when not connected', async () => {
      const result = await executeQuery('cosmos_query', { module: 'bank', subcommand: 'balances' }, null, ADDRESS);
      expect(result?.success).toBe(false);
      expect(result?.error).toContain('Not connected to blockchain');
    });

    it('returns error when module is missing', async () => {
      const result = await executeQuery('cosmos_query', { subcommand: 'balances' }, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(false);
      expect(result?.error).toContain('module is required');
    });

    it('returns error when subcommand is missing', async () => {
      const result = await executeQuery('cosmos_query', { module: 'bank' }, CLIENT_MANAGER, ADDRESS);
      expect(result?.success).toBe(false);
      expect(result?.error).toContain('subcommand is required');
    });

    it('returns error for invalid args format', async () => {
      const result = await executeQuery(
        'cosmos_query',
        { module: 'bank', subcommand: 'balances', args: 123 },
        CLIENT_MANAGER,
        ADDRESS,
      );
      expect(result?.success).toBe(false);
      expect(result?.error).toContain('Invalid args format');
    });

    it('executes query and returns result', async () => {
      const queryResult = { balances: [{ denom: 'umfx', amount: '1000' }] };
      mockCosmosQuery.mockResolvedValue(queryResult);

      const result = await executeQuery(
        'cosmos_query',
        { module: 'bank', subcommand: 'balances', args: '["manifest1abc"]' },
        CLIENT_MANAGER,
        ADDRESS,
      );
      expect(result?.success).toBe(true);
      expect(result?.data).toEqual(queryResult);
      expect(mockCosmosQuery).toHaveBeenCalledWith(CLIENT_MANAGER, 'bank', 'balances', ['manifest1abc']);
    });

    it('passes empty args array when args omitted', async () => {
      mockCosmosQuery.mockResolvedValue({});

      await executeQuery(
        'cosmos_query',
        { module: 'bank', subcommand: 'params' },
        CLIENT_MANAGER,
        ADDRESS,
      );
      expect(mockCosmosQuery).toHaveBeenCalledWith(CLIENT_MANAGER, 'bank', 'params', []);
    });
  });
});
