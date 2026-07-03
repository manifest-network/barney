import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeListApps,
  executeAppStatus,
  executeGetBalance,
  executeGetLogs,
  executeBrowseCatalog,
  executeCosmosQuery,
  executeLeaseHistory,
  executeAppDiagnostics,
  executeAppReleases,
  executeRequestFaucet,
} from './compositeQueries';
import type { ToolExecutorOptions } from './types';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-core';
import type { AppEntry } from '../../registry/appRegistry';
import { makeRegistry } from './testHelpers';

// Mock external modules
vi.mock('../../api/billing', () => ({
  getLeasesByTenant: vi.fn(),
  getLeasesByTenantPaginated: vi.fn(),
  getLease: vi.fn().mockResolvedValue(null),
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
}));

vi.mock('../../api/fred', () => ({
  getLeaseStatus: vi.fn(),
  getLeaseLogs: vi.fn(),
  getLeaseProvision: vi.fn(),
  getLeaseReleases: vi.fn(),
}));

vi.mock('../../api/faucet', () => ({
  isFaucetEnabled: vi.fn().mockReturnValue(true),
  getFaucetBaseUrl: vi.fn().mockReturnValue('http://localhost:8000'),
  FAUCET_COOLDOWN_HOURS: 24,
}));

vi.mock('@manifest-network/manifest-mcp-chain', () => ({
  requestFaucet: vi.fn(),
}));

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => ({
  ...(await importOriginal()),
  cosmosQuery: vi.fn(),
}));

vi.mock('../../api/readClient', () => ({ getReadClient: vi.fn() }));

const mockGetBalance = vi.fn();

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

import { getLeasesByTenant, getLeasesByTenantPaginated, getLease } from '../../api/billing';
import { getProviders, getSKUs } from '../../api/sku';
import { getProviderHealth } from '../../api/provider-api';
import { getLeaseLogs, getLeaseProvision, getLeaseReleases } from '../../api/fred';
import { cosmosQuery } from '@manifest-network/manifest-mcp-core';
import { getReadClient } from '../../api/readClient';
import { isFaucetEnabled } from '../../api/faucet';
import { requestFaucet } from '@manifest-network/manifest-mcp-chain';
import { logError } from '../../utils/errors';

const ADDRESS = 'manifest1abc';
const MOCK_QUERY_CLIENT = {} as Awaited<ReturnType<CosmosClientManager['getQueryClient']>>;
const CLIENT_MANAGER = {
  getQueryClient: vi.fn().mockResolvedValue(MOCK_QUERY_CLIENT),
} as unknown as CosmosClientManager;

function makeOptions(overrides: Partial<ToolExecutorOptions> = {}): ToolExecutorOptions {
  return {
    clientManager: CLIENT_MANAGER,
    address: ADDRESS,
    appRegistry: makeRegistry(),
    tiers: [],
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
    expect(result.error).toContain('No unique app found matching');
  });

  it('returns app status', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry }));
    expect(result.success).toBe(true);
    expect((result.data as any).name).toBe('my-app');
    expect((result.data as any).status).toBe('running');
  });

  it('surfaces customDomains array when chain returns lease items with custom domains', async () => {
    const app = makeApp({ connection: { host: 'fred.example.com', fqdn: 'auto.barney0.manifest0.net' } });
    vi.mocked(getLease).mockResolvedValue({
      state: 2,
      items: [
        { skuUuid: 's1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: 'app.example.com' },
      ],
    } as any);
    const registry = makeRegistry([app]);
    const result = await executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).customDomains).toEqual([
        { serviceName: '', customDomain: 'app.example.com' },
      ]);
    }
  });

  it('emits CustomDomainCard displayCard when exactly one custom domain is set', async () => {
    const app = makeApp({ connection: { host: 'fred.example.com', fqdn: 'auto.barney0.manifest0.net' } });
    vi.mocked(getLease).mockResolvedValue({
      state: 2,
      items: [
        { skuUuid: 's1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: 'app.example.com' },
      ],
    } as any);
    const registry = makeRegistry([app]);
    const result = await executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry }));
    expect(result.success).toBe(true);
    if (result.success && !result.requiresConfirmation) {
      expect(result.displayCard?.type).toBe('custom_domain');
      if (result.displayCard?.type === 'custom_domain') {
        expect(result.displayCard.data.fqdn).toBe('app.example.com');
        expect(result.displayCard.data.expectedCnameTarget).toBe('auto.barney0.manifest0.net');
      }
    }
  });

  it('emits a consolidated multi-domain CustomDomainCard when multiple custom domains are set', async () => {
    const app = makeApp({
      manifest: JSON.stringify({ services: { web: { image: 'nginx' }, api: { image: 'node' } } }),
      connection: {
        host: 'fred.example.com',
        services: {
          web: { fqdn: 'web.auto.barney0.manifest0.net' },
          api: { fqdn: 'api.auto.barney0.manifest0.net' },
        },
      },
    });
    vi.mocked(getLease).mockResolvedValue({
      state: 2,
      items: [
        { skuUuid: 's1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'web', customDomain: 'web.example.com' },
        { skuUuid: 's2', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'api', customDomain: 'api.example.com' },
      ],
    } as any);
    const registry = makeRegistry([app]);
    const result = await executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry }));
    expect(result.success).toBe(true);
    if (result.success && !result.requiresConfirmation) {
      expect(result.displayCard?.type).toBe('custom_domain');
      if (result.displayCard?.type === 'custom_domain') {
        expect(result.displayCard.data.fqdn).toBe('');
        expect(result.displayCard.data.domains).toHaveLength(2);
        expect(result.displayCard.data.domains).toEqual([
          { serviceName: 'web', customDomain: 'web.example.com', expectedCnameTarget: 'web.auto.barney0.manifest0.net' },
          { serviceName: 'api', customDomain: 'api.example.com', expectedCnameTarget: 'api.auto.barney0.manifest0.net' },
        ]);
        expect(result.displayCard.data.serviceNames).toEqual(['web', 'api']);
      }
      expect((result.data as any).customDomains).toHaveLength(2);
    }
  });

  it('does not include customDomains key when no items have a custom domain', async () => {
    const app = makeApp();
    vi.mocked(getLease).mockResolvedValue({
      state: 2,
      items: [
        { skuUuid: 's1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: '' },
      ],
    } as any);
    const registry = makeRegistry([app]);
    const result = await executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).customDomains).toBeUndefined();
    }
  });

  it('emits a no-domain CustomDomainCard for a single-item lease without a custom domain', async () => {
    const app = makeApp({ status: 'running', connection: { host: 'fred.example.com', fqdn: 'auto.barney0.manifest0.net' } });
    vi.mocked(getLease).mockResolvedValue({
      state: 2,
      items: [
        { skuUuid: 's1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: '' },
      ],
    } as any);
    const registry = makeRegistry([app]);
    const result = await executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry }));
    expect(result.success).toBe(true);
    if (result.success && !result.requiresConfirmation) {
      expect(result.displayCard?.type).toBe('custom_domain');
      if (result.displayCard?.type === 'custom_domain') {
        expect(result.displayCard.data.fqdn).toBe('');
        expect(result.displayCard.data.serviceName).toBe('');
        expect(result.displayCard.data.expectedCnameTarget).toBe('auto.barney0.manifest0.net');
      }
    }
  });

  it('emits a no-domain card with serviceNames picker for a stack with no domains', async () => {
    const app = makeApp({
      status: 'running',
      manifest: JSON.stringify({ services: { web: { image: 'nginx' }, api: { image: 'node' } } }),
      connection: { host: 'fred.example.com', fqdn: 'auto.barney0.manifest0.net' },
    });
    vi.mocked(getLease).mockResolvedValue({
      state: 2,
      items: [
        { skuUuid: 's1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'web', customDomain: '' },
        { skuUuid: 's2', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'api', customDomain: '' },
      ],
    } as any);
    const registry = makeRegistry([app]);
    const result = await executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry }));
    expect(result.success).toBe(true);
    if (result.success && !result.requiresConfirmation) {
      expect(result.displayCard?.type).toBe('custom_domain');
      if (result.displayCard?.type === 'custom_domain') {
        expect(result.displayCard.data.fqdn).toBe('');
        expect(result.displayCard.data.serviceName).toBe('');
        expect(result.displayCard.data.serviceNames).toEqual(['web', 'api']);
        expect(result.displayCard.data.domains).toBeUndefined();
      }
    }
  });

  it('does NOT emit no-domain card for legacy multi-item leases with all-unnamed items', async () => {
    // Pre-ENG-56 stacks: chain LeaseItems lack service names. The stored
    // manifest still claims named services, but `executeSetCustomDomain`
    // rejects these with "predates per-service domains and has multiple
    // items without service names" (compositeTransactions.ts:2871-2876).
    // Gate must read from chain truth, not the manifest — otherwise the
    // user fills a doomed form and only sees the error at TX time.
    // See PR #93 Copilot 3236552275.
    const app = makeApp({
      status: 'running',
      manifest: JSON.stringify({ services: { web: { image: 'nginx' }, db: { image: 'postgres' } } }),
    });
    vi.mocked(getLease).mockResolvedValue({
      state: 2,
      items: [
        { skuUuid: 's1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: '' },
        { skuUuid: 's2', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: '' },
      ],
    } as any);
    const registry = makeRegistry([app]);
    const result = await executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry }));
    expect(result.success).toBe(true);
    if (result.success && !result.requiresConfirmation) {
      expect(result.displayCard).toBeUndefined();
    }
  });

  it('emits no-domain card with chain-derived picker for modern multi-item named stacks', async () => {
    // Happy path for modern stacks: chain has named items, attach is allowed,
    // picker offers the chain-derived service names.
    const app = makeApp({
      status: 'running',
      connection: { host: 'fred.example.com', fqdn: 'auto.barney0.manifest0.net' },
    });
    vi.mocked(getLease).mockResolvedValue({
      state: 2,
      items: [
        { skuUuid: 's1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'web', customDomain: '' },
        { skuUuid: 's2', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'db', customDomain: '' },
      ],
    } as any);
    const registry = makeRegistry([app]);
    const result = await executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry }));
    expect(result.success).toBe(true);
    if (result.success && !result.requiresConfirmation) {
      expect(result.displayCard?.type).toBe('custom_domain');
      if (result.displayCard?.type === 'custom_domain') {
        expect(result.displayCard.data.fqdn).toBe('');
        expect(result.displayCard.data.serviceNames).toEqual(['web', 'db']);
      }
    }
  });

  it('drops unnamed items from picker for mixed named/unnamed lease items', async () => {
    // Edge case: chain has one named + one unnamed item. The chain accepts
    // attach to the named one (executeSetCustomDomain auto-selects when only
    // one named item exists). Picker must NOT include the unnamed sibling —
    // the chain has no way to address it for set-domain.
    const app = makeApp({
      status: 'running',
      // Manifest claims both services, but chain truth says only one is named.
      manifest: JSON.stringify({ services: { web: { image: 'nginx' }, db: { image: 'postgres' } } }),
      connection: { host: 'fred.example.com', fqdn: 'auto.barney0.manifest0.net' },
    });
    vi.mocked(getLease).mockResolvedValue({
      state: 2,
      items: [
        { skuUuid: 's1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'web', customDomain: '' },
        { skuUuid: 's2', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: '' },
      ],
    } as any);
    const registry = makeRegistry([app]);
    const result = await executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry }));
    expect(result.success).toBe(true);
    if (result.success && !result.requiresConfirmation) {
      expect(result.displayCard?.type).toBe('custom_domain');
      if (result.displayCard?.type === 'custom_domain') {
        expect(result.displayCard.data.serviceNames).toEqual(['web']);
      }
    }
  });

  it('does NOT emit no-domain card for stopped apps', async () => {
    const app = makeApp({ status: 'stopped', connection: { host: 'fred.example.com', fqdn: 'auto.barney0.manifest0.net' } });
    vi.mocked(getLease).mockResolvedValue({
      state: 3, // CLOSED
      items: [
        { skuUuid: 's1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: '' },
      ],
    } as any);
    const registry = makeRegistry([app]);
    const result = await executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry }));
    expect(result.success).toBe(true);
    if (result.success && !result.requiresConfirmation) {
      expect(result.displayCard).toBeUndefined();
    }
  });
});

describe('executeGetBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getReadClient).mockResolvedValue(
      { getBalance: mockGetBalance } as unknown as Awaited<ReturnType<typeof getReadClient>>,
    );
  });

  it('returns error without wallet', async () => {
    const result = await executeGetBalance(makeOptions({ address: undefined }));
    expect(result.success).toBe(false);
  });

  it('returns error without clientManager', async () => {
    const result = await executeGetBalance(makeOptions({ clientManager: null }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Not connected');
  });

  it('returns formatted balance', async () => {
    mockGetBalance.mockResolvedValue({
      balances: [{ denom: 'umfx', amount: '5000000' }],
      current_balance: [{ denom: 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr', amount: '100000000' }],
      spending_per_hour: [{ denom: 'umfx', amount: '3600' }],
      hours_remaining: '24.0',
      running_apps: '1',
      credits: {
        active_leases: '1',
        pending_leases: '0',
        reserved_amounts: [],
        balances: [{ denom: 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr', amount: '100000000' }],
        available_balances: [],
      },
    });

    const result = await executeGetBalance(makeOptions());
    expect(result.success).toBe(true);
    // Wallet address is threaded into the read client's getBalance call.
    expect(mockGetBalance).toHaveBeenCalledWith(ADDRESS);
    const data = result.data as any;
    expect(data.credits).toBe(100);
    expect(data.hours_remaining).toBe(24);
    expect(data.running_apps).toBe(1);
    // mfx_balance field removed — not user-surfaced
    expect(data.mfx_balance).toBeUndefined();
  });

  it('returns null hours_remaining when spending_per_hour is empty', async () => {
    mockGetBalance.mockResolvedValue({
      balances: [{ denom: 'umfx', amount: '5000000' }],
      current_balance: [{ denom: 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr', amount: '100000000' }],
      spending_per_hour: [],
      hours_remaining: '0',
      running_apps: '0',
      credits: {
        active_leases: '0',
        pending_leases: '0',
        reserved_amounts: [],
        balances: [{ denom: 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr', amount: '100000000' }],
        available_balances: [],
      },
    });

    const result = await executeGetBalance(makeOptions());
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.running_apps).toBe(0);
    expect(data.spending_per_hour).toBe(0);
    expect(data.hours_remaining).toBeNull();
  });

  it('returns zero credits when credit account missing', async () => {
    mockGetBalance.mockResolvedValue({
      balances: [{ denom: 'umfx', amount: '5000000' }],
      credits: null,
    });

    const result = await executeGetBalance(makeOptions());
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.credits).toBe(0);
    expect(data.running_apps).toBe(0);
    expect(data.hours_remaining).toBeNull();
  });

  it('returns error when getBalance throws', async () => {
    mockGetBalance.mockRejectedValue(new Error('RPC down'));

    const result = await executeGetBalance(makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('RPC down');
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
      reverse: true,
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
      reverse: true,
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

const mockSigning = {
  authTokens: {
    getAuthToken: vi.fn().mockResolvedValue('mock-auth-token'),
    getLeaseDataAuthToken: vi.fn().mockResolvedValue('mock-lease-data-token'),
  },
  withSign: <T,>(fn: () => Promise<T>) => fn(),
};

describe('executeGetLogs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error without wallet', async () => {
    const result = await executeGetLogs({ app_name: 'my-app' }, makeOptions({ address: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Wallet not connected');
  });

  it('returns error without app registry', async () => {
    const result = await executeGetLogs({ app_name: 'my-app' }, makeOptions({ appRegistry: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('App registry not available');
  });

  it('returns error without app_name', async () => {
    const result = await executeGetLogs({}, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('App name is required');
  });

  it('returns error when app not found', async () => {
    const result = await executeGetLogs({ app_name: 'nonexistent' }, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No unique app found matching');
  });

  it('returns error when app has no provider URL', async () => {
    const app = makeApp({ providerUrl: undefined });
    const registry = makeRegistry([app]);
    const result = await executeGetLogs(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('no provider URL');
  });

  it('returns error for stopped app', async () => {
    const app = makeApp({ status: 'stopped' });
    const result = await executeGetLogs(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: makeRegistry([app]), signing: mockSigning })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('stopped');
  });

  it('returns error without signing', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeGetLogs(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: undefined })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Signing not available');
  });

  it('returns logs for running app', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseLogs).mockResolvedValue({
      lease_uuid: app.leaseUuid,
      tenant: ADDRESS,
      provider_uuid: app.providerUuid,
      logs: { web: 'line1\nline2\nline3' },
    });

    const result = await executeGetLogs(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.app_name).toBe('my-app');
    expect(data.logs.web).toBe('line1\nline2\nline3');
    expect(data.truncated).toBe(false);

    // Verify displayCard is present with matching data
    const card = (result as any).displayCard;
    expect(card).toBeDefined();
    expect(card.type).toBe('logs');
    expect(card.data.app_name).toBe('my-app');
    expect(card.data.logs.web).toBe('line1\nline2\nline3');
    expect(card.data.truncated).toBe(false);

    // Verify auth token was created
    expect(getLeaseLogs).toHaveBeenCalledWith(
      app.providerUrl,
      app.leaseUuid,
      'mock-auth-token',
      100
    );
  });

  it('handles getLeaseLogs failure gracefully', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseLogs).mockRejectedValue(new Error('connection refused'));

    const result = await executeGetLogs(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to fetch logs');
    expect(result.error).toContain('connection refused');
  });

  it('respects custom tail parameter', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseLogs).mockResolvedValue({
      lease_uuid: app.leaseUuid,
      tenant: ADDRESS,
      provider_uuid: app.providerUuid,
      logs: { web: 'line1' },
    });

    await executeGetLogs(
      { app_name: 'my-app', tail: 50 },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(getLeaseLogs).toHaveBeenCalledWith(
      app.providerUrl,
      app.leaseUuid,
      'mock-auth-token',
      50
    );
  });

  it('truncates very long logs', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    const longLog = 'x'.repeat(5000);
    vi.mocked(getLeaseLogs).mockResolvedValue({
      lease_uuid: app.leaseUuid,
      tenant: ADDRESS,
      provider_uuid: app.providerUuid,
      logs: { web: longLog },
    });

    const result = await executeGetLogs(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(true);
    const data = result.data as any;
    // LLM context gets truncated
    expect(data.logs.web.length).toBe(4000);
    expect(data.truncated).toBe(true);

    // displayCard shows full logs (user sees everything)
    const card = (result as any).displayCard;
    expect(card).toBeDefined();
    expect(card.data.truncated).toBe(false);
    expect(card.data.logs.web.length).toBe(5000);
  });

  it('keeps every service full for the LogCard but caps and drops for the LLM (multi-service)', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    // web fits whole (3000). db (3000, tail-marked 'X') is kept only as its
    // 1000-char TAIL so the marker survives. cache (500) is dropped from the LLM
    // path once the 4000-char budget is exhausted.
    const web = 'W'.repeat(3000);
    const db = 'D'.repeat(2999) + 'X';
    const cache = 'C'.repeat(500);
    vi.mocked(getLeaseLogs).mockResolvedValue({
      lease_uuid: app.leaseUuid,
      tenant: ADDRESS,
      provider_uuid: app.providerUuid,
      logs: { web, db, cache },
    });

    const result = await executeGetLogs(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(true);

    // LLM path: capped at MAX_LOG_CHARS=4000 total. web whole, db tail-truncated
    // to 1000 (keeps 'X'), cache dropped entirely.
    const data = result.data as any;
    expect(data.logs.web).toBe(web);
    expect(data.logs.db.length).toBe(1000);
    expect(data.logs.db.endsWith('X')).toBe(true);
    expect(data.logs.cache).toBeUndefined();
    const llmTotal = Object.values(data.logs as Record<string, string>)
      .reduce((n, s) => n + s.length, 0);
    expect(llmTotal).toBe(4000);
    expect(data.truncated).toBe(true);

    // LogCard path: every service full, nothing dropped, truncated:false.
    const card = (result as any).displayCard;
    expect(card.type).toBe('logs');
    expect(card.data.logs.web.length).toBe(3000);
    expect(card.data.logs.db.length).toBe(3000);
    expect(card.data.logs.db.endsWith('X')).toBe(true);
    expect(card.data.logs.cache.length).toBe(500);
    expect(card.data.truncated).toBe(false);
  });

  it('finds app via fuzzy match', async () => {
    const app = makeApp({ name: 'my-cool-app' });
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseLogs).mockResolvedValue({
      lease_uuid: app.leaseUuid,
      tenant: ADDRESS,
      provider_uuid: app.providerUuid,
      logs: { web: 'log output' },
    });

    const result = await executeGetLogs(
      { app_name: 'cool-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(true);
    expect((result.data as any).app_name).toBe('my-cool-app');
  });
});

describe('executeAppDiagnostics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error without wallet', async () => {
    const result = await executeAppDiagnostics({ app_name: 'my-app' }, makeOptions({ address: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Wallet not connected');
  });

  it('returns error without app registry', async () => {
    const result = await executeAppDiagnostics({ app_name: 'my-app' }, makeOptions({ appRegistry: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('App registry not available');
  });

  it('returns error without app_name', async () => {
    const result = await executeAppDiagnostics({}, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('App name is required');
  });

  it('returns error when app not found', async () => {
    const result = await executeAppDiagnostics({ app_name: 'nonexistent' }, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No unique app found matching');
  });

  it('returns error for stopped app', async () => {
    const app = makeApp({ status: 'stopped' });
    const registry = makeRegistry([app]);
    const result = await executeAppDiagnostics(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('stopped');
  });

  it('returns error when app has no provider URL', async () => {
    const app = makeApp({ providerUrl: undefined });
    const registry = makeRegistry([app]);
    const result = await executeAppDiagnostics(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('no provider URL');
  });

  it('returns provision status for app', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseProvision).mockResolvedValue({
      status: 'failed',
      fail_count: 3,
      last_error: 'OOMKilled',
    });

    const result = await executeAppDiagnostics(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.app_name).toBe('my-app');
    expect(data.status).toBe('failed');
    expect(data.fail_count).toBe(3);
    expect(data.last_error).toBe('OOMKilled');
  });

  it('handles getLeaseProvision failure gracefully', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseProvision).mockRejectedValue(new Error('connection refused'));

    const result = await executeAppDiagnostics(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to fetch diagnostics');
    expect(result.error).toContain('connection refused');
  });
});

describe('executeAppReleases', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error without wallet', async () => {
    const result = await executeAppReleases({ app_name: 'my-app' }, makeOptions({ address: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Wallet not connected');
  });

  it('returns error without app registry', async () => {
    const result = await executeAppReleases({ app_name: 'my-app' }, makeOptions({ appRegistry: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('App registry not available');
  });

  it('returns error without app_name', async () => {
    const result = await executeAppReleases({}, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('App name is required');
  });

  it('returns error when app not found', async () => {
    const result = await executeAppReleases({ app_name: 'nonexistent' }, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No unique app found matching');
  });

  it('returns error for stopped app', async () => {
    const app = makeApp({ status: 'stopped' });
    const registry = makeRegistry([app]);
    const result = await executeAppReleases(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('stopped');
  });

  it('returns error when app has no provider URL', async () => {
    const app = makeApp({ providerUrl: undefined });
    const registry = makeRegistry([app]);
    const result = await executeAppReleases(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('no provider URL');
  });

  it('returns releases for app', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseReleases).mockResolvedValue({
      lease_uuid: app.leaseUuid,
      tenant: ADDRESS,
      provider_uuid: app.providerUuid,
      releases: [
        { version: 1, image: 'nginx:1.0', status: 'active', created_at: '2024-01-01T00:00:00Z' },
        { version: 2, image: 'nginx:2.0', status: 'superseded', created_at: '2024-01-02T00:00:00Z' },
      ],
    });

    const result = await executeAppReleases(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.app_name).toBe('my-app');
    expect(data.releases).toHaveLength(2);
    expect(data.count).toBe(2);
  });

  it('handles getLeaseReleases failure gracefully', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseReleases).mockRejectedValue(new Error('connection refused'));

    const result = await executeAppReleases(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to fetch releases');
    expect(result.error).toContain('connection refused');
  });
});

describe('executeRequestFaucet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isFaucetEnabled).mockReturnValue(true);
  });

  it('returns error when faucet is disabled', async () => {
    vi.mocked(isFaucetEnabled).mockReturnValue(false);
    const result = await executeRequestFaucet(makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Faucet is not available');
    expect(requestFaucet).not.toHaveBeenCalled();
  });

  it('returns error without wallet', async () => {
    const result = await executeRequestFaucet(makeOptions({ address: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Wallet not connected');
  });

  it('returns success when all tokens received', async () => {
    vi.mocked(requestFaucet).mockResolvedValue({
      address: ADDRESS,
      results: [
        { denom: 'umfx', success: true },
        { denom: 'factory/addr/upwr', success: true },
      ],
    });

    const result = await executeRequestFaucet(makeOptions());
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.message).toContain('MFX');
    expect(data.message).toContain('PWR');
    expect(data.results).toHaveLength(2);
  });

  it('returns failure when all tokens fail', async () => {
    vi.mocked(requestFaucet).mockResolvedValue({
      address: ADDRESS,
      results: [
        { denom: 'umfx', success: false, error: 'cooldown active' },
        { denom: 'factory/addr/upwr', success: false, error: 'cooldown active' },
      ],
    });

    const result = await executeRequestFaucet(makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('24-hour cooldown');
    expect(result.error).toContain('umfx');
  });

  it('returns partial success when one token fails', async () => {
    vi.mocked(requestFaucet).mockResolvedValue({
      address: ADDRESS,
      results: [
        { denom: 'umfx', success: true },
        { denom: 'factory/addr/upwr', success: false, error: 'cooldown active' },
      ],
    });

    const result = await executeRequestFaucet(makeOptions());
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.message).toContain('Partial success');
    expect(data.message).toContain('umfx');
    expect(data.message).toContain('cooldown active');
  });

  it('returns user-friendly error and logs when requestFaucet throws', async () => {
    vi.mocked(requestFaucet).mockRejectedValue(
      new Error('Faucet has no tokens configured')
    );

    const result = await executeRequestFaucet(makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('temporarily unavailable');
    expect(logError).toHaveBeenCalledWith(
      'compositeQueries.executeRequestFaucet',
      expect.any(Error)
    );
  });
});
