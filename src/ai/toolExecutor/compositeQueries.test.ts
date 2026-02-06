import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeListApps,
  executeAppStatus,
  executeGetBalance,
  executeBrowseCatalog,
  executeCosmosQuery,
  executeLeaseHistory,
} from './compositeQueries';
import type { ToolExecutorOptions, AppRegistryAccess } from './types';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import type { AppEntry } from '../../registry/appRegistry';

// Mock external modules
vi.mock('../../api/billing', () => ({
  getLeasesByTenant: vi.fn(),
  getLeasesByTenantPaginated: vi.fn(),
  getCreditAccount: vi.fn(),
  getCreditEstimate: vi.fn(),
  getLease: vi.fn(),
  LeaseState: {
    LEASE_STATE_UNSPECIFIED: 0,
    LEASE_STATE_PENDING: 1,
    LEASE_STATE_ACTIVE: 2,
    LEASE_STATE_CLOSED: 3,
    LEASE_STATE_REJECTED: 4,
    LEASE_STATE_EXPIRED: 5,
  },
  LEASE_STATE_MAP: {
    pending: 1,
    active: 2,
    closed: 3,
    rejected: 4,
    expired: 5,
  },
}));

vi.mock('../../api/bank', () => ({
  getAllBalances: vi.fn(),
}));

vi.mock('../../api/sku', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/sku')>();
  return {
    ...actual,
    getProviders: vi.fn(),
    getSKUs: vi.fn(),
  };
});

vi.mock('../../api/provider-api', () => ({
  getProviderHealth: vi.fn(),
  getLeaseConnectionInfo: vi.fn(),
  createSignMessage: vi.fn().mockReturnValue('sign-msg'),
  createAuthToken: vi.fn().mockReturnValue('auth-token'),
}));

vi.mock('../../api/fred', () => ({
  getLeaseStatus: vi.fn(),
}));

vi.mock('@manifest-network/manifest-mcp-browser', () => ({
  cosmosQuery: vi.fn(),
}));

vi.mock('../../utils/errors', () => ({
  logError: vi.fn(),
}));

vi.mock('../../utils/leaseState', () => ({
  LEASE_STATE_LABELS: {
    0: 'Unspecified',
    1: 'Pending',
    2: 'Active',
    3: 'Closed',
    4: 'Rejected',
    5: 'Expired',
  },
}));

import { getLeasesByTenant, getCreditAccount, getCreditEstimate, getLeasesByTenantPaginated } from '../../api/billing';
import { getAllBalances } from '../../api/bank';
import { getProviders, getSKUs } from '../../api/sku';
import { getProviderHealth } from '../../api/provider-api';
import { cosmosQuery } from '@manifest-network/manifest-mcp-browser';

const ADDRESS = 'manifest1abc';
const CLIENT_MANAGER = {} as CosmosClientManager;

function makeRegistry(apps: AppEntry[] = []): AppRegistryAccess {
  const store = [...apps];
  return {
    getApps: () => [...store],
    getApp: (_addr: string, name: string) => store.find((a) => a.name === name) ?? null,
    findApp: (_addr: string, name: string) => {
      const lower = name.toLowerCase();
      return store.find((a) => a.name.endsWith(`-${lower}`)) ?? store.find((a) => a.name.includes(lower)) ?? null;
    },
    getAppByLease: (_addr: string, uuid: string) => store.find((a) => a.leaseUuid === uuid) ?? null,
    addApp: (_addr: string, entry: AppEntry) => { store.push(entry); return entry; },
    updateApp: (_addr: string, uuid: string, updates: Partial<Omit<AppEntry, 'leaseUuid'>>) => {
      const idx = store.findIndex((a) => a.leaseUuid === uuid);
      if (idx === -1) return null;
      store[idx] = { ...store[idx], ...updates };
      return store[idx];
    },
  };
}

function makeOptions(overrides: Partial<ToolExecutorOptions> = {}): ToolExecutorOptions {
  return {
    clientManager: CLIENT_MANAGER,
    address: ADDRESS,
    appRegistry: makeRegistry(),
    ...overrides,
  };
}

function makeApp(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    name: 'my-app',
    leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
    size: 'small',
    providerUuid: '660e8400-e29b-41d4-a716-446655440000',
    providerUrl: 'https://fred.example.com',
    createdAt: Date.now(),
    status: 'running',
    ...overrides,
  };
}

describe('executeListApps', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error without wallet', async () => {
    const result = await executeListApps({}, makeOptions({ address: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Wallet not connected');
  });

  it('returns empty list when no apps', async () => {
    vi.mocked(getLeasesByTenant).mockResolvedValue([]);
    const result = await executeListApps({}, makeOptions());
    expect(result.success).toBe(true);
    expect((result.data as any).count).toBe(0);
  });

  it('returns apps filtered by state', async () => {
    // Return the running app's lease as active so it stays "running"
    const app = makeApp({ status: 'running' });
    const stoppedApp = makeApp({ name: 'stopped-app', leaseUuid: 'uuid-2', status: 'stopped' });

    vi.mocked(getLeasesByTenant).mockImplementation(async (_addr, state) => {
      if (state === 2) return [{ uuid: app.leaseUuid } as any]; // active
      return []; // pending
    });

    const registry = makeRegistry([app, stoppedApp]);
    const result = await executeListApps({ state: 'stopped' }, makeOptions({ appRegistry: registry }));
    expect(result.success).toBe(true);
    expect((result.data as any).count).toBe(1);
    expect((result.data as any).apps[0].name).toBe('stopped-app');
  });

  it('reconciles running apps with chain state', async () => {
    // Lease is no longer active on chain
    vi.mocked(getLeasesByTenant).mockResolvedValue([]);

    const app = makeApp({ status: 'running' });
    const registry = makeRegistry([app]);
    const result = await executeListApps({ state: 'all' }, makeOptions({ appRegistry: registry }));

    expect(result.success).toBe(true);
    // App should now be marked stopped after reconciliation
    const apps = (result.data as any).apps;
    expect(apps[0].status).toBe('stopped');
  });
});

describe('executeAppStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error when app not found', async () => {
    const result = await executeAppStatus({ app_name: 'nonexistent' }, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No app found');
  });

  it('returns app status', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry }));
    expect(result.success).toBe(true);
    expect((result.data as any).name).toBe('my-app');
    expect((result.data as any).status).toBe('running');
  });
});

describe('executeGetBalance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error without wallet', async () => {
    const result = await executeGetBalance(makeOptions({ address: undefined }));
    expect(result.success).toBe(false);
  });

  it('returns formatted balance', async () => {
    vi.mocked(getAllBalances).mockResolvedValue([{ denom: 'umfx', amount: '5000000' }]);
    vi.mocked(getCreditAccount).mockResolvedValue({
      creditAccount: { tenant: ADDRESS, creditAddress: 'credit-addr', activeLeaseCount: 1n, pendingLeaseCount: 0n, reservedAmounts: [] },
      balances: [{ denom: 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr', amount: '100000000' }],
      availableBalances: [],
    } as any);
    vi.mocked(getCreditEstimate).mockResolvedValue({
      currentBalance: [{ denom: 'umfx', amount: '100000000' }],
      totalRatePerSecond: [{ denom: 'umfx', amount: '1' }],
      estimatedDurationSeconds: 86400n,
      activeLeaseCount: 1n,
    } as any);

    const result = await executeGetBalance(makeOptions());
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.credits).toBe(100);
    expect(data.mfx_balance).toBe(5);
    expect(data.hours_remaining).toBe(24);
    expect(data.running_apps).toBe(1);
  });
});

describe('executeBrowseCatalog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns providers and tiers', async () => {
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', name: 'Provider 1', apiUrl: 'https://p1.example.com', active: true, admin: 'addr' } as any,
    ]);
    vi.mocked(getSKUs).mockResolvedValue([
      {
        uuid: 's1',
        name: 'docker-small',
        providerUuid: 'p1',
        price: { denom: 'umfx', amount: '1000000' },
        unit: 1,
        active: true,
      } as any,
    ]);
    vi.mocked(getProviderHealth).mockResolvedValue({ status: 'healthy', provider_uuid: 'p1' });

    const result = await executeBrowseCatalog();
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0].healthy).toBe(true);
    expect(data.tiers['docker-small']).toHaveLength(1);
  });
});

describe('executeCosmosQuery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error without client manager', async () => {
    const result = await executeCosmosQuery({ module: 'bank', subcommand: 'params' }, null);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Not connected');
  });

  it('executes query', async () => {
    vi.mocked(cosmosQuery).mockResolvedValue({ module: 'bank', subcommand: 'params', result: {} } as Awaited<ReturnType<typeof cosmosQuery>>);
    const result = await executeCosmosQuery({ module: 'bank', subcommand: 'params' }, CLIENT_MANAGER);
    expect(result.success).toBe(true);
    expect(cosmosQuery).toHaveBeenCalledWith(CLIENT_MANAGER, 'bank', 'params', []);
  });
});

describe('executeLeaseHistory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error without wallet', async () => {
    const result = await executeLeaseHistory({}, makeOptions({ address: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Wallet not connected');
  });

  it('returns leases with default params (all states, limit 10, offset 0)', async () => {
    vi.mocked(getLeasesByTenantPaginated).mockResolvedValue({
      leases: [
        { uuid: 'lease-1', state: 2, tenant: ADDRESS, items: [], createdAt: '2024-01-01T00:00:00Z', providerUuid: 'p1' } as any,
        { uuid: 'lease-2', state: 3, tenant: ADDRESS, items: [], createdAt: '2024-01-02T00:00:00Z', closedAt: '2024-01-03T00:00:00Z', closureReason: 'user', providerUuid: 'p1' } as any,
      ],
      pagination: { total: 2n, nextKey: new Uint8Array() },
    });

    const result = await executeLeaseHistory({}, makeOptions());
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.count).toBe(2);
    expect(data.total).toBe(2);
    expect(data.offset).toBe(0);
    expect(data.limit).toBe(10);
    expect(data.hasMore).toBe(false);
  });

  it('filters by state', async () => {
    vi.mocked(getLeasesByTenantPaginated).mockResolvedValue({
      leases: [
        { uuid: 'lease-1', state: 2, tenant: ADDRESS, items: [], createdAt: '2024-01-01T00:00:00Z', providerUuid: 'p1' } as any,
      ],
      pagination: { total: 1n, nextKey: new Uint8Array() },
    });

    await executeLeaseHistory({ state: 'active' }, makeOptions());
    expect(getLeasesByTenantPaginated).toHaveBeenCalledWith(ADDRESS, {
      stateFilter: 2,
      limit: 10,
      offset: 0,
    });
  });

  it('passes pagination params (limit/offset)', async () => {
    vi.mocked(getLeasesByTenantPaginated).mockResolvedValue({
      leases: [],
      pagination: { total: 50n, nextKey: new Uint8Array() },
    });

    const result = await executeLeaseHistory({ limit: 5, offset: 20 }, makeOptions());
    expect(getLeasesByTenantPaginated).toHaveBeenCalledWith(ADDRESS, {
      stateFilter: 0,
      limit: 5,
      offset: 20,
    });
    const data = result.data as any;
    expect(data.limit).toBe(5);
    expect(data.offset).toBe(20);
  });

  it('clamps limit to max 50', async () => {
    vi.mocked(getLeasesByTenantPaginated).mockResolvedValue({
      leases: [],
      pagination: undefined,
    });

    await executeLeaseHistory({ limit: 100 }, makeOptions());
    expect(getLeasesByTenantPaginated).toHaveBeenCalledWith(ADDRESS, expect.objectContaining({ limit: 50 }));
  });

  it('clamps limit to min 1', async () => {
    vi.mocked(getLeasesByTenantPaginated).mockResolvedValue({
      leases: [],
      pagination: undefined,
    });

    await executeLeaseHistory({ limit: -5 }, makeOptions());
    expect(getLeasesByTenantPaginated).toHaveBeenCalledWith(ADDRESS, expect.objectContaining({ limit: 1 }));
  });

  it('cross-references with app registry for friendly names', async () => {
    const app = makeApp({ leaseUuid: 'lease-1', name: 'my-app' });
    const registry = makeRegistry([app]);

    vi.mocked(getLeasesByTenantPaginated).mockResolvedValue({
      leases: [
        { uuid: 'lease-1', state: 2, tenant: ADDRESS, items: [], createdAt: '2024-01-01T00:00:00Z', providerUuid: 'p1' } as any,
        { uuid: 'lease-2', state: 3, tenant: ADDRESS, items: [], createdAt: '2024-01-02T00:00:00Z', providerUuid: 'p1' } as any,
      ],
      pagination: { total: 2n, nextKey: new Uint8Array() },
    });

    const result = await executeLeaseHistory({}, makeOptions({ appRegistry: registry }));
    const data = result.data as any;
    expect(data.leases[0].name).toBe('my-app');
    expect(data.leases[1].name).toBeUndefined();
  });

  it('returns error for invalid state', async () => {
    const result = await executeLeaseHistory({ state: 'invalid' }, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid state');
  });

  it('computes hasMore correctly', async () => {
    vi.mocked(getLeasesByTenantPaginated).mockResolvedValue({
      leases: Array.from({ length: 10 }, (_, i) => ({
        uuid: `lease-${i}`,
        state: 2,
        tenant: ADDRESS,
        items: [],
        createdAt: '2024-01-01T00:00:00Z',
        providerUuid: 'p1',
      })) as any[],
      pagination: { total: 25n, nextKey: new Uint8Array() },
    });

    const result = await executeLeaseHistory({ limit: 10, offset: 0 }, makeOptions());
    const data = result.data as any;
    expect(data.hasMore).toBe(true);
    expect(data.total).toBe(25);
  });
});
