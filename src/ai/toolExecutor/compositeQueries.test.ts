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
import type { CosmosClientManager } from '@manifest-network/manifest-sdk';
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
}));

vi.mock('../../api/fred', () => ({
  getLeaseLogs: vi.fn(),
  getLeaseProvision: vi.fn(),
  getLeaseReleases: vi.fn(),
}));

vi.mock('../../api/faucet', () => ({
  isFaucetEnabled: vi.fn().mockReturnValue(true),
  getFaucetBaseUrl: vi.fn().mockReturnValue('http://localhost:8000'),
  FAUCET_COOLDOWN_HOURS: 24,
}));

vi.mock('@manifest-network/manifest-sdk/faucet', () => ({
  requestFaucet: vi.fn(),
}));

vi.mock('@manifest-network/manifest-sdk/chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@manifest-network/manifest-sdk/chain')>()),
  cosmosQuery: vi.fn(),
}));

// ENG-312 Phase 5: app_status delegates to the SDK deploy facade's appStatus.
// Spread the original facade (types/helpers stay real); mock only appStatus.
vi.mock('@manifest-network/manifest-sdk/deploy', async (importOriginal) => ({
  ...(await importOriginal()),
  appStatus: vi.fn(),
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
import { cosmosQuery } from '@manifest-network/manifest-sdk/chain';
import { appStatus, FRED_REASON_GUIDANCE } from '@manifest-network/manifest-sdk/deploy';
import { getReadClient } from '../../api/readClient';
import { isFaucetEnabled } from '../../api/faucet';
import { requestFaucet } from '@manifest-network/manifest-sdk/faucet';
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
    // items without service names" (compositeTransactions.ts).
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

  // ── ENG-312 Phase 5: the signer path routes through the SDK appStatus
  // primitive (chain lease + fred status + connection in one call). The chain-
  // only fallback above (no signing → getLease) still covers the domain/reconcile
  // matrix; these cover the appStatus branch specifically.
  describe('signer path (appStatus)', () => {
    beforeEach(() => {
      // buildBarneyCtx awaits the read client for ctx.query.
      vi.mocked(getReadClient).mockResolvedValue({ query: {} } as any);
    });

    it('reconciles to running and refreshes connection from appStatus', async () => {
      const app = makeApp({ status: 'deploying' });
      const registry = makeRegistry([app]);
      vi.mocked(appStatus).mockResolvedValue({
        lease_uuid: app.leaseUuid,
        chainState: { state: 2, providerUuid: 'p1', createdAt: '', closedAt: undefined, items: [] },
        fredStatus: { state: 2 },
        connection: { host: 'fred.example.com', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 30080 } } },
      } as any);

      const result = await executeAppStatus(
        { app_name: 'my-app' },
        makeOptions({ appRegistry: registry, signing: mockSigning })
      );

      expect(result.success).toBe(true);
      expect((result.data as any).status).toBe('running');
      expect(appStatus).toHaveBeenCalledWith(expect.anything(), { address: ADDRESS, leaseUuid: app.leaseUuid });
      // Two independent observations, recorded separately: the chain says
      // ACTIVE, and fred's `provision_status` is absent here — a degraded
      // provider drops it via omitempty — so NO provisionState is invented.
      // `status` is derived (rule 5: chain-active, no provider evidence).
      expect(registry.updateApp).toHaveBeenCalledWith(
        ADDRESS,
        app.leaseUuid,
        expect.objectContaining({ chainState: 'active', connection: expect.objectContaining({ host: 'fred.example.com' }) })
      );
      expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.provisionState).toBeUndefined();
    });

    it('leaves chainState "unknown" and does not reconcile when appStatus throws', async () => {
      const app = makeApp();
      const registry = makeRegistry([app]);
      vi.mocked(appStatus).mockRejectedValue(new Error('Lease "550e8400" not found on chain'));

      const result = await executeAppStatus(
        { app_name: 'my-app' },
        makeOptions({ appRegistry: registry, signing: mockSigning })
      );

      expect(result.success).toBe(true);
      expect((result.data as any).chainState).toBe('unknown');
      expect((result.data as any).status).toBe('running'); // unchanged — no reconcile fired
      expect(logError).toHaveBeenCalled();
    });

    it('surfaces customDomains from appStatus chainState.items', async () => {
      const app = makeApp({ connection: { host: 'fred.example.com', fqdn: 'auto.barney0.manifest0.net' } });
      const registry = makeRegistry([app]);
      vi.mocked(appStatus).mockResolvedValue({
        lease_uuid: app.leaseUuid,
        chainState: {
          state: 2, providerUuid: 'p1', createdAt: '', closedAt: undefined,
          items: [
            { skuUuid: 's1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: 'app.example.com' },
          ],
        },
      } as any);

      const result = await executeAppStatus(
        { app_name: 'my-app' },
        makeOptions({ appRegistry: registry, signing: mockSigning })
      );

      expect(result.success).toBe(true);
      expect((result.data as any).customDomains).toEqual([{ serviceName: '', customDomain: 'app.example.com' }]);
    });
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

  // ENG-711 / fred v0.13.0: /health answers 200 for every tier and the verdict
  // lives in the body. `healthy` stays an exact match on 'healthy' (a
  // chain-impaired `degraded` fails every lease-resolving endpoint), but the
  // diagnosis must no longer be discarded. Fred's check keys and messages below
  // are the real ones — v0.13.0 internal/api/handlers.go records "chain" with
  // "chain connectivity failed", "payload_store" with "payload store
  // unavailable", and "backend:<name>" with "backend health check failed".
  describe('provider health (three-state)', () => {
    /** One provider with an apiUrl, one SKU on it — the minimum for a catalog row. */
    function mockCatalog(apiUrl = 'https://p1.example.com'): void {
      vi.mocked(getProviders).mockResolvedValue([
        { uuid: 'p1', name: 'Provider 1', apiUrl, active: true, admin: 'addr' } as any,
      ]);
      vi.mocked(getSKUs).mockResolvedValue([]);
    }

    async function providerRow(): Promise<any> {
      const result = await executeBrowseCatalog();
      expect(result.success).toBe(true);
      return (result.data as any).providers[0];
    }

    it('reports a degraded provider with the failing check named', async () => {
      mockCatalog();
      vi.mocked(getProviderHealth).mockResolvedValue({
        status: 'degraded',
        provider_uuid: 'p1',
        checks: {
          chain: { status: 'unhealthy', message: 'chain connectivity failed' },
          'backend:docker-1': { status: 'healthy' },
        },
        stats: { in_flight_provisions: 2 },
      });

      const row = await providerRow();
      expect(row.healthy).toBe(false);
      expect(row.health_status).toBe('degraded');
      expect(row.healthError).toMatch(/chain \(chain connectivity failed\)/);
      // A passing check is noise, and listing it would bury the one that matters.
      expect(row.healthError).not.toContain('backend:docker-1');
    });

    it('reports an unhealthy provider distinguishably from a degraded one', async () => {
      mockCatalog();
      vi.mocked(getProviderHealth).mockResolvedValue({
        status: 'unhealthy',
        provider_uuid: 'p1',
        checks: { payload_store: { status: 'unhealthy', message: 'payload store unavailable' } },
      });
      const unhealthy = await providerRow();

      vi.mocked(getProviderHealth).mockResolvedValue({
        status: 'degraded',
        provider_uuid: 'p1',
        checks: { chain: { status: 'unhealthy', message: 'chain connectivity failed' } },
      });
      const degraded = await providerRow();

      expect(unhealthy.healthy).toBe(false);
      expect(unhealthy.health_status).toBe('unhealthy');
      expect(unhealthy.healthError).toContain('payload_store');
      // The regression guard for the whole ENG-711 class: before this change both
      // tiers serialized to exactly `{ healthy: false }`.
      expect(JSON.stringify(unhealthy)).not.toBe(JSON.stringify(degraded));
    });

    it('marks a provider that returned no verdict as unreachable, not as a failed check', async () => {
      mockCatalog();
      vi.mocked(getProviderHealth).mockResolvedValue(null);

      const row = await providerRow();
      expect(row.healthy).toBe(false);
      expect(row.health_status).toBe('unreachable');
      // We never got a body, so we must not claim a named check failed.
      expect(row.healthError).toBeUndefined();
    });

    it('re-throws an AbortError from the health check', async () => {
      mockCatalog();
      vi.mocked(getProviderHealth).mockRejectedValue(new DOMException('aborted', 'AbortError'));
      await expect(executeBrowseCatalog()).rejects.toThrow('aborted');
    });

    it('passes an unrecognized tier through verbatim', async () => {
      mockCatalog();
      vi.mocked(getProviderHealth).mockResolvedValue({ status: 'quarantined', provider_uuid: 'p1' });

      const row = await providerRow();
      expect(row.healthy).toBe(false);
      // The tier set is open — a switch-based implementation fails right here.
      expect(row.health_status).toBe('quarantined');
    });

    it('skips the health call entirely when the provider has no apiUrl', async () => {
      mockCatalog('');

      const row = await providerRow();
      expect(row.healthy).toBe(false);
      expect(row.health_status).toBe('no_api_url');
      expect(getProviderHealth).not.toHaveBeenCalled();
    });

    it('strips and caps provider-controlled health text', async () => {
      const RLO = '\u202E';
      mockCatalog();
      vi.mocked(getProviderHealth).mockResolvedValue({
        status: `deg${RLO}raded`,
        provider_uuid: 'p1',
        checks: { chain: { status: 'unhealthy', message: 'x'.repeat(5000) } },
      });

      const row = await providerRow();
      expect(row.health_status).not.toContain(RLO);
      expect(Array.from(row.health_status as string)).toHaveLength(9);
      // maxLength + 1: sanitizeForDisplay appends a single-code-point ellipsis.
      expect(row.healthError.length).toBeLessThanOrEqual(1025);
    });

    it('keeps the singleton checks ahead of the backend fleet when capping', async () => {
      mockCatalog();
      const checks: Record<string, { status: string; message?: string }> = {
        payload_store: { status: 'unhealthy', message: 'payload store unavailable' },
      };
      for (let i = 1; i <= 9; i++) {
        checks[`backend:docker-${i}`] = { status: 'unhealthy', message: 'backend health check failed' };
      }
      vi.mocked(getProviderHealth).mockResolvedValue({ status: 'unhealthy', provider_uuid: 'p1', checks });

      const row = await providerRow();
      // Go sorts the map keys, so `backend:*` arrives first on the wire — a
      // head-of-list cap would drop payload_store, the check that matters most.
      expect(row.healthError).toContain('payload_store');
      expect(row.healthError).toMatch(/, and 5 more$/);
    });

    it('reports the bare verdict when a non-healthy body names no failing check', async () => {
      mockCatalog();
      vi.mocked(getProviderHealth).mockResolvedValue({ status: 'degraded', provider_uuid: 'p1' });

      const row = await providerRow();
      expect(row.healthy).toBe(false);
      expect(row.healthError).toBe('Provider reports status "degraded"');
    });

    it('emits no healthError for a healthy provider', async () => {
      mockCatalog();
      vi.mocked(getProviderHealth).mockResolvedValue({ status: 'healthy', provider_uuid: 'p1', checks: {} });

      const row = await providerRow();
      expect(row.healthy).toBe(true);
      expect(row.health_status).toBe('healthy');
      expect('healthError' in row).toBe(false);
    });
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
  providerAuth: { providerToken: vi.fn(), leaseDataToken: vi.fn() },
  authTokens: {
    getAuthToken: vi.fn().mockResolvedValue('mock-auth-token'),
    getLeaseDataAuthToken: vi.fn().mockResolvedValue('mock-lease-data-token'),
  },
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

  // ENG-774 twin of the fixture above: fred v0.13.0 stopped sending `last_error`
  // and sends a curated `reason` + `message` instead. Both eras stay live because
  // providers upgrade independently of barney.
  it('projects the post-ENG-508 reason/message pair and its guidance', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseProvision).mockResolvedValue({
      status: 'failed',
      fail_count: 3,
      reason: 'ContainerExited',
      message: 'container exited',
    });

    const result = await executeAppDiagnostics(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.reason).toBe('ContainerExited');
    expect(data.message).toBe('container exited');
    expect('last_error' in data).toBe(false);
    // NOT the SDK's sentence: it spells the call `get_logs({ lease_uuid, tail:
    // 200 })`, and barney's get_logs takes `app_name` — a model that followed it
    // would emit `get_logs({ lease_uuid })` and burn an iteration on
    // `No unique app found matching "undefined"`. The tool-free `explanation`
    // half of the taxonomy IS kept. See failureGuidance.ts.
    expect(data.next_step).toContain(FRED_REASON_GUIDANCE.ContainerExited.explanation);
    expect(data.next_step).toContain('get_logs("my-app", 200)');
    expect(data.next_step).not.toContain('lease_uuid');
    expect(data.next_step).not.toContain(FRED_REASON_GUIDANCE.ContainerExited.nextStep);
  });

  // fred's provisionReason() stamps `Unknown` on ANY failed provision with no
  // authored reason, so this remap covers the generic path, not an edge case.
  it('remaps the Unknown next step onto get_logs(app_name)', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'failed', fail_count: 1, reason: 'Unknown' });

    const result = await executeAppDiagnostics(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    const data = result.data as any;
    expect(data.next_step).toContain(FRED_REASON_GUIDANCE.Unknown.explanation);
    expect(data.next_step).toContain('get_logs("my-app", 200)');
    expect(data.next_step).not.toContain('lease_uuid');
  });

  // `restore_app` is a tool barney does not have at all — grep src/ai/tools.ts.
  it('remaps the RestoreFailed next step away from the restore_app tool', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'failed', fail_count: 1, reason: 'RestoreFailed' });

    const result = await executeAppDiagnostics(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    const data = result.data as any;
    expect(data.next_step).toContain(FRED_REASON_GUIDANCE.RestoreFailed.explanation);
    expect(data.next_step).toContain('app_status("my-app")');
    expect(data.next_step).not.toContain('restore_app');
  });

  // The other six curated sentences name only tools barney has, so they are
  // relayed unchanged — the remap is a targeted substitution, not a rewrite.
  it('relays a barney-compatible next step verbatim', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'failed', fail_count: 1, reason: 'ImagePullFailed' });

    const result = await executeAppDiagnostics(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    const data = result.data as any;
    expect(data.next_step).toBe(FRED_REASON_GUIDANCE.ImagePullFailed.nextStep);
  });

  it('passes an unrecognized reason through without guidance', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseProvision).mockResolvedValue({
      status: 'failed',
      fail_count: 1,
      reason: 'SomeFutureReason',
    });

    const result = await executeAppDiagnostics(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    expect(result.success).toBe(true);
    const data = result.data as any;
    // Fred's reason set is open and add-only: a value this client does not know
    // is relayed verbatim, and the absence of guidance is the normal case.
    expect(data.reason).toBe('SomeFutureReason');
    expect('next_step' in data).toBe(false);
  });

  it('serves diagnostics for a failed app', async () => {
    const app = makeApp({ status: 'failed' });
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseProvision).mockResolvedValue({
      status: 'failed',
      fail_count: 2,
      reason: 'ImagePullFailed',
    });

    const result = await executeAppDiagnostics(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    // A failed app is precisely when diagnostics are wanted; only 'stopped' refuses.
    expect(result.success).toBe(true);
    expect((result.data as any).reason).toBe('ImagePullFailed');
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

  it('serves releases for a failed app', async () => {
    const app = makeApp({ status: 'failed' });
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseReleases).mockResolvedValue({
      lease_uuid: app.leaseUuid,
      tenant: ADDRESS,
      provider_uuid: app.providerUuid,
      releases: [{ version: 1, image: 'nginx:1.0', status: 'active', created_at: '2024-01-01T00:00:00Z' }],
    });

    const result = await executeAppReleases(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    // The release history is what tells the user which version the provider is
    // actually running — most valuable exactly when barney marked the app failed.
    expect(result.success).toBe(true);
    expect(getLeaseReleases).toHaveBeenCalled();
    expect((result.data as any).count).toBe(1);
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

// ═══════════════════════════════════════════════════════════════════════════
// F4 — the query executors are WRITERS too, and they now record the
// observation each of them actually made.
// ═══════════════════════════════════════════════════════════════════════════

describe('F4 — list_apps records only the chain observation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records chainState absent for a lease that left the tenant’s live set', async () => {
    vi.mocked(getLeasesByTenant).mockResolvedValue([]);

    const app = makeApp({ status: 'running' });
    const registry = makeRegistry([app]);
    const result = await executeListApps({ state: 'all' }, makeOptions({ appRegistry: registry }));

    expect(result.success).toBe(true);
    // The OBSERVATION, not the summary: "we looked and it was gone".
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { chainState: 'absent' });
    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.chainState).toBe('absent');
    expect(stored?.status).toBe('stopped');
    // Absence says nothing about WHY, so it must not manufacture a provider verdict.
    expect(stored?.provisionState).toBeUndefined();
  });

  it('reports the DERIVED status, not a hard-coded "stopped"', async () => {
    // A provider `failed` verdict outranks chain-absence, so the row this
    // response renders must come from the registry's derivation rather than
    // from a local assignment that would silently disagree with the sidebar.
    vi.mocked(getLeasesByTenant).mockResolvedValue([]);

    const app = makeApp({ status: 'running', provisionState: 'failed' });
    const registry = makeRegistry([app]);
    const result = await executeListApps({ state: 'all' }, makeOptions({ appRegistry: registry }));

    expect((result.data as any).apps[0].status).toBe('failed');
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('failed');
  });
});

describe('F4 — app_status records fred’s provision verdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getReadClient).mockResolvedValue({ query: {} } as any);
  });

  function mockAppStatus(leaseUuid: string, fredStatus: unknown, chainStateValue = 2) {
    vi.mocked(appStatus).mockResolvedValue({
      lease_uuid: leaseUuid,
      chainState: { state: chainStateValue, providerUuid: 'p1', createdAt: '', closedAt: undefined, items: [] },
      fredStatus,
      connection: undefined,
    } as any);
  }

  const run = (registry: ReturnType<typeof makeRegistry>) =>
    executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry, signing: mockSigning }));

  it('records `ready` as a confirmed provisioning observation', async () => {
    const app = makeApp({ status: 'deploying' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, { state: 2, provision_status: 'ready' });

    const result = await run(registry);

    expect(result.success).toBe(true);
    expect(registry.updateApp).toHaveBeenCalledWith(
      ADDRESS, app.leaseUuid,
      expect.objectContaining({ chainState: 'active', provisionState: 'confirmed' }),
    );
    expect((result.data as any).status).toBe('running');
  });

  it('records `failed` as a provisioning failure even though the chain lease is ACTIVE', async () => {
    // fred v0.13.0 models exactly this: an ACTIVE chain lease whose provision
    // has failed. fred only closes such a lease once FailCount passes
    // maxReprovisionAttempts, so the chain is no evidence the workload is up —
    // and before this change app_status classified from chain state alone and
    // never read provision_status at all.
    const app = makeApp({ status: 'running' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, { state: 2, provision_status: 'failed' });

    const result = await run(registry);

    expect(registry.updateApp).toHaveBeenCalledWith(
      ADDRESS, app.leaseUuid,
      expect.objectContaining({ chainState: 'active', provisionState: 'failed' }),
    );
    expect((result.data as any).status).toBe('failed');
  });

  it('records `deprovisioning` as a failure too — the SDK’s PROVISION_FAILED set', async () => {
    const app = makeApp({ status: 'running' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, { state: 2, provision_status: 'deprovisioning' });

    await run(registry);

    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.provisionState).toBe('failed');
  });

  it('reports a mid-flight provision_status as deploying, never as running', async () => {
    // `provisioning` / `restarting` / `updating` / `unknown` all mean fred has
    // NOT confirmed the workload is up. Recording no observation left the
    // chain-only rule answering 'running' for an app fred says is still coming
    // up. (`failing`, the SDK's fifth PROVISION_IN_PROGRESS member, is a verdict
    // and classifies 'failed' — see the `failing` case below.)
    const app = makeApp({ status: 'deploying' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, { state: 2, provision_status: 'provisioning' });

    const result = await run(registry);

    // Exact object, not objectContaining: this test's predecessor pinned that
    // ONLY the chain observation was written, and that exactness is the half
    // that catches a writer quietly adding a field it did not observe.
    expect(registry.updateApp).toHaveBeenCalledWith(
      ADDRESS, app.leaseUuid,
      { chainState: 'active', provisionState: 'unconfirmed' },
    );
    expect((result.data as any).status).toBe('deploying');
  });

  it('reports `retained` as deploying — fred tore the workload down and kept the volumes', async () => {
    // fred v0.13.0 publishes `retained` for a soft-deleted lease whose volumes
    // are held for the grace window; recovery is an explicit restore onto a
    // FRESH lease, so the workload behind this one is gone. 'unconfirmed' — not
    // 'failed' — because the chain observation must still be able to overrule
    // it: the close that normally follows records 'absent' → 'stopped', and a
    // sticky 'failed' would relabel an ordinary stop as a failure.
    const app = makeApp({ status: 'running', chainState: 'active', provisionState: 'confirmed' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, { state: 2, provision_status: 'retained' });

    const result = await run(registry);

    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.provisionState).toBe('unconfirmed');
    expect((result.data as any).status).toBe('deploying');
  });

  it('claims nothing from a provision_status in none of the SDK sets', async () => {
    // The open-set rule: a value a newer fred adds is not evidence in either
    // direction, so nothing is written and the chain observation stands alone.
    const app = makeApp({ status: 'deploying' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, { state: 2, provision_status: 'quiescing' });

    const result = await run(registry);

    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { chainState: 'active' });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.provisionState).toBeUndefined();
    expect((result.data as any).status).toBe('running');
  });

  it('records a PENDING chain lease so a stale `running` cannot survive it', async () => {
    // `executeListApps` and `reconcileWithChain` both record 'pending';
    // app_status used to fall through both the ACTIVE and terminal branches and
    // leave the entry untouched.
    const app = makeApp({ status: 'running', chainState: 'active' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, null, 1); // chain PENDING

    const result = await run(registry);

    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { chainState: 'pending' });
    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.chainState).toBe('pending');
    expect(stored?.provisionState).toBeUndefined();
    expect((result.data as any).status).toBe('deploying');
  });

  it('records a PENDING chain lease on the chain-only path too', async () => {
    // The reconcile block is shared: both the signer read (appStatus) and the
    // no-signer read (getLease) resolve `leaseState`, so the single branch
    // covers both. Without a signer there is no fred evidence at all.
    const app = makeApp({ status: 'running', chainState: 'active' });
    const registry = makeRegistry([app]);
    vi.mocked(getLease).mockResolvedValue({ state: 1, items: [] } as any);

    const result = await executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry }));

    expect(appStatus).not.toHaveBeenCalled();
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { chainState: 'pending' });
    expect((result.data as any).status).toBe('deploying');
  });

  it('records a provider-side terminal lease as a provisioning failure', async () => {
    const app = makeApp({ status: 'running' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, { state: 3 }); // fred says CLOSED, chain says ACTIVE

    const result = await run(registry);

    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { provisionState: 'failed' });
    expect((result.data as any).status).toBe('failed');
  });

  it('does NOT erase a provider failure when fred is unreachable', async () => {
    // The "trust the chain" branch has no provider evidence at all. It used to
    // write a flat `status: 'running'`, silently reverting a provider verdict
    // every time fred happened to be unreachable.
    const app = makeApp({ status: 'failed', provisionState: 'failed' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, null);

    const result = await run(registry);

    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { chainState: 'active' });
    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.chainState).toBe('active');
    expect(stored?.provisionState).toBe('failed');
    expect(stored?.status).toBe('failed');
    expect((result.data as any).status).toBe('failed');
  });

  it('still reports a chain-active app as running when there is no provider evidence at all', async () => {
    // The ordinary case must be unchanged: an entry with no provider
    // observation derives 'running' from chain-active.
    const app = makeApp({ status: 'deploying' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, null);

    const result = await run(registry);

    expect((result.data as any).status).toBe('running');
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.provisionState).toBeUndefined();
  });

  it('records a chain-terminal lease as a chain observation only', async () => {
    const app = makeApp({ status: 'running' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, null, 3); // chain CLOSED

    const result = await run(registry);

    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { chainState: 'absent' });
    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.provisionState).toBeUndefined();
    expect((result.data as any).status).toBe('stopped');
  });
});

describe('N2/N3 — observations must be REFRESHABLE, not one-way latches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getReadClient).mockResolvedValue({ query: {} } as any);
  });

  function mockAppStatus(leaseUuid: string, fredStatus: unknown, chainStateValue = 2) {
    vi.mocked(appStatus).mockResolvedValue({
      lease_uuid: leaseUuid,
      chainState: { state: chainStateValue, providerUuid: 'p1', createdAt: '', closedAt: undefined, items: [] },
      fredStatus,
      connection: undefined,
    } as any);
  }

  const run = (registry: ReturnType<typeof makeRegistry>) =>
    executeAppStatus({ app_name: 'my-app' }, makeOptions({ appRegistry: registry, signing: mockSigning }));

  it('clears a stale provisionState "failed" when fred reports ready again', async () => {
    // N3, the whole point of this round. fred's reconciler marks
    // provision_status 'failed' with FailCount 1 and re-provisions ~10s later
    // without closing the lease (v0.13.0 internal/provisioner/reconciler.go).
    // A status check landing inside that window records 'failed'; if nothing
    // ever recorded the POSITIVE observation, that write would be permanent —
    // the app would stay out of list_apps(running), out of restart_app and out
    // of custom-domain DNS polling forever.
    const app = makeApp({ status: 'failed', chainState: 'active', provisionState: 'failed' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, { state: 2, provision_status: 'ready' });

    const result = await run(registry);

    expect(registry.updateApp).toHaveBeenCalledWith(
      ADDRESS, app.leaseUuid,
      expect.objectContaining({ chainState: 'active', provisionState: 'confirmed' }),
    );
    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.provisionState).toBe('confirmed');
    expect(stored?.status).toBe('running');
    expect((result.data as any).status).toBe('running');
  });

  it('clears a stale provisionState "unconfirmed" when fred reports ready', async () => {
    // N2: a deploy (or, after N4, a restart/update wait) that ended without a
    // verdict records 'unconfirmed' → derived 'deploying'. Every recovery tool
    // refuses a 'deploying' app, so without a re-observation point stop_app was
    // the only exit. app_status is that point.
    const app = makeApp({ status: 'deploying', provisionState: 'unconfirmed' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, { state: 2, provision_status: 'ready' });

    const result = await run(registry);

    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.provisionState).toBe('confirmed');
    expect(stored?.status).toBe('running');
    expect((result.data as any).status).toBe('running');
  });

  it('does not re-open a healed app on a mid-flight snapshot', async () => {
    // The other half of the in-flight rule: such a reading fills a gap, but it
    // must not RETRACT a confirmation (the `inFlight` guard in
    // `executeAppStatus`). Writing 'unconfirmed' from 'restarting' would reproduce the
    // exact drop-out (no list_apps, no restart_app, no DNS polling) that N3
    // complains about — transiently rather than permanently, but for a workload
    // that is demonstrably fine.
    const app = makeApp({ status: 'running', chainState: 'active', provisionState: 'confirmed' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, { state: 2, provision_status: 'restarting' });

    const result = await run(registry);

    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.provisionState).toBe('confirmed');
    expect(stored?.status).toBe('running');
    expect((result.data as any).status).toBe('running');
  });

  it('but a confirmed app whose container died is NOT protected by that guard', async () => {
    // The other half of the pair above, and what C1 caught: the guard keyed on
    // the SDK's PROVISION_IN_PROGRESS, which contains `failing` — so a CONFIRMED
    // app whose container exited kept its confirmation and derived 'running'.
    // fred enters Failing only from Ready, on evContainerDied, writing
    // Reason: ContainerExited (internal/backend/shared/leasesm/lease_sm.go): a
    // verdict, and the same one compositeTransactions.ts already trusted. Both
    // files now read it through `isUnsettledProvisionStatus`.
    const app = makeApp({ status: 'running', chainState: 'active', provisionState: 'confirmed' });
    const registry = makeRegistry([app]);
    mockAppStatus(app.leaseUuid, { state: 2, provision_status: 'failing', reason: 'ContainerExited' });

    const result = await run(registry);

    expect(registry.updateApp).toHaveBeenCalledWith(
      ADDRESS, app.leaseUuid,
      expect.objectContaining({ provisionState: 'failed' }),
    );
    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.provisionState).toBe('failed');
    expect(stored?.status).toBe('failed');
    expect((result.data as any).status).toBe('failed');
  });
});

describe('N3 — list_apps re-observes the chain in BOTH directions', () => {
  beforeEach(() => vi.clearAllMocks());

  /** Split active/pending lease sets, as the chain returns them. */
  function mockLeases(active: string[], pending: string[] = []) {
    vi.mocked(getLeasesByTenant).mockImplementation(async (_addr, state) =>
      (state === 2 ? active : pending).map((uuid) => ({ uuid }) as any),
    );
  }

  it('records the POSITIVE chain observation, not only the negative one', async () => {
    // Before: the write was guarded on `(running|deploying) && !live`, so
    // 'active' was unreachable — list_apps could only ever report bad news.
    const app = makeApp({ status: 'running' });
    const registry = makeRegistry([app]);
    mockLeases([app.leaseUuid]);

    const result = await executeListApps({ state: 'all' }, makeOptions({ appRegistry: registry }));

    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { chainState: 'active' });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.chainState).toBe('active');
    expect((result.data as any).apps[0].status).toBe('running');
  });

  it('records PENDING as its own observation instead of collapsing it into active', async () => {
    // The old code unioned both lease sets into one `activeUuids` Set, which
    // made 'pending' literally unrecordable. Derivation maps pending →
    // 'deploying', which is not the same claim as 'running'.
    const app = makeApp({ status: 'running' });
    const registry = makeRegistry([app]);
    mockLeases([], [app.leaseUuid]);

    const result = await executeListApps({ state: 'all' }, makeOptions({ appRegistry: registry }));

    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { chainState: 'pending' });
    expect((result.data as any).apps[0].status).toBe('deploying');
  });

  it('re-observes an app the summary had already written off as stopped', async () => {
    // The guard skipped every app not summarised running/deploying, so a
    // 'stopped' entry whose lease is in fact live could never be corrected here.
    // (`reconcileWithChain` on the sidebar's 15s timer already did exactly this,
    // so the two chain readers now agree rather than disagreeing by design.)
    const app = makeApp({ status: 'stopped' });
    const registry = makeRegistry([app]);
    mockLeases([app.leaseUuid]);

    const result = await executeListApps({ state: 'all' }, makeOptions({ appRegistry: registry }));

    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { chainState: 'active' });
    expect((result.data as any).apps[0].status).toBe('running');
  });

  it('the positive observation cannot promote an app the PROVIDER failed', async () => {
    // Derivation rule 1 (provisionState 'failed') outranks rule 5's chain-only
    // inference, so re-observing the chain as ACTIVE records the chain fact
    // without touching the verdict — the F4 clobber cannot come back in through
    // this new write.
    const app = makeApp({ status: 'failed', provisionState: 'failed' });
    const registry = makeRegistry([app]);
    mockLeases([app.leaseUuid]);

    const result = await executeListApps({ state: 'all' }, makeOptions({ appRegistry: registry }));

    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { chainState: 'active' });
    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.chainState).toBe('active');
    expect(stored?.status).toBe('failed');
    expect((result.data as any).apps[0].status).toBe('failed');
  });

  it('still records absence — for every app, not just the running ones', async () => {
    const app = makeApp({ status: 'stopped', chainState: 'active' });
    const registry = makeRegistry([app]);
    mockLeases([]);

    await executeListApps({ state: 'all' }, makeOptions({ appRegistry: registry }));

    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { chainState: 'absent' });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.chainState).toBe('absent');
  });
});

describe('N3 — the three provider-read tools agree on one refusal rule', () => {
  beforeEach(() => vi.clearAllMocks());

  it('get_logs serves a FAILED app', async () => {
    // A failed app is when logs matter most, and barney already reads them in
    // that state internally — deployError.ts's fetchFailureLogs calls
    // getLeaseLogs on a failed deploy and puts the output in chat. The refusal
    // only meant the model could see logs barney volunteered and not logs the
    // user asked for. Now it matches app_diagnostics / app_releases: only
    // 'stopped' refuses.
    const app = makeApp({ status: 'failed', provisionState: 'failed' });
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseLogs).mockResolvedValue({
      lease_uuid: app.leaseUuid,
      tenant: ADDRESS,
      provider_uuid: app.providerUuid,
      logs: { web: 'panic: cannot bind port' },
    });

    const result = await executeGetLogs(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );

    expect(result.success).toBe(true);
    expect((result.data as any).logs.web).toContain('panic');
  });

  it('get_logs serves a DEPLOYING app stuck at provisionState "unconfirmed"', async () => {
    const app = makeApp({ status: 'deploying', provisionState: 'unconfirmed' });
    const registry = makeRegistry([app]);
    vi.mocked(getLeaseLogs).mockResolvedValue({
      lease_uuid: app.leaseUuid,
      tenant: ADDRESS,
      provider_uuid: app.providerUuid,
      logs: { web: 'pulling image...' },
    });

    const result = await executeGetLogs(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );

    expect(result.success).toBe(true);
  });

  it('get_logs still refuses a STOPPED app, and says only that', async () => {
    // The lease is gone, so the lease-scoped ADR-036 token authenticates
    // against nothing and the provider has deprovisioned.
    const app = makeApp({ status: 'stopped' });
    const result = await executeGetLogs(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: makeRegistry([app]), signing: mockSigning })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('stopped');
    expect(result.error).not.toContain('failed');
    expect(getLeaseLogs).not.toHaveBeenCalled();
  });

  it('app_diagnostics and app_releases admit the entry a chain-terminal deploy leaves behind', async () => {
    // N1's payoff, exercised through the real derivation. The registry write is
    // byte-for-byte what handleDeployManifestError's TerminalChainStateError arm
    // now performs.
    const app = makeApp({ status: 'deploying' });
    const registry = makeRegistry([app]);
    registry.updateApp(ADDRESS, app.leaseUuid, { chainState: 'absent', provisionState: 'failed' });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('failed');

    vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'failed', fail_count: 1, reason: 'Unknown' });
    vi.mocked(getLeaseReleases).mockResolvedValue({ lease_uuid: app.leaseUuid, releases: [] } as any);

    const diagnostics = await executeAppDiagnostics(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    const releases = await executeAppReleases(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );

    expect(diagnostics.success).toBe(true);
    expect(releases.success).toBe(true);
  });

  it('and would REFUSE the same entry if only the chain half were recorded', async () => {
    // The regression N1 fixes, pinned as its own case so the reason the second
    // observation exists cannot be optimised away later: with `chainState:
    // 'absent'` alone, derivation rule 2 yields 'stopped' — the one status both
    // tools refuse — on the exact failure the user most needs explained.
    const app = makeApp({ status: 'deploying' });
    const registry = makeRegistry([app]);
    registry.updateApp(ADDRESS, app.leaseUuid, { chainState: 'absent' });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('stopped');

    const diagnostics = await executeAppDiagnostics(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );
    const releases = await executeAppReleases(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: registry, signing: mockSigning })
    );

    expect(diagnostics.success).toBe(false);
    expect(diagnostics.error).toContain('stopped');
    expect(releases.success).toBe(false);
    expect(releases.error).toContain('stopped');
  });
});
