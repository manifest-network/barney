import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeListApps,
  executeAppStatus,
  executeGetBalance,
  executeBrowseCatalog,
  executeCosmosQuery,
} from './compositeQueries';
import type { ToolExecutorOptions, AppRegistryAccess } from './types';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import type { AppEntry } from '../../registry/appRegistry';

// Mock external modules
vi.mock('../../api/billing', () => ({
  getLeasesByTenant: vi.fn(),
  getCreditAccount: vi.fn(),
  getCreditEstimate: vi.fn(),
  getLease: vi.fn(),
  LeaseState: { LEASE_STATE_ACTIVE: 2, LEASE_STATE_PENDING: 1 },
}));

vi.mock('../../api/bank', () => ({
  getAllBalances: vi.fn(),
}));

vi.mock('../../api/sku', () => ({
  getProviders: vi.fn(),
  getSKUs: vi.fn(),
}));

vi.mock('../../api/provider-api', () => ({
  getProviderHealth: vi.fn(),
  createSignMessage: vi.fn().mockReturnValue('sign-msg'),
  createAuthToken: vi.fn().mockReturnValue('auth-token'),
}));

vi.mock('../../api/fred', () => ({
  getLeaseStatus: vi.fn(),
  getLeaseInfo: vi.fn(),
}));

vi.mock('@manifest-network/manifest-mcp-browser', () => ({
  cosmosQuery: vi.fn(),
}));

vi.mock('../../utils/errors', () => ({
  logError: vi.fn(),
}));

import { getLeasesByTenant, getCreditAccount, getCreditEstimate } from '../../api/billing';
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
    vi.mocked(cosmosQuery).mockResolvedValue({ params: {} });
    const result = await executeCosmosQuery({ module: 'bank', subcommand: 'params' }, CLIENT_MANAGER);
    expect(result.success).toBe(true);
    expect(cosmosQuery).toHaveBeenCalledWith(CLIENT_MANAGER, 'bank', 'params', []);
  });
});
