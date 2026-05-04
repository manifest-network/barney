import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeSetCustomDomain,
  executeConfirmedSetCustomDomain,
} from './compositeTransactions';
import type { ToolExecutorOptions } from './types';
import type { AppEntry } from '../../registry/appRegistry';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-core';
import { makeRegistry } from './testHelpers';

// External module mocks
vi.mock('../../api/leaseItems', () => ({ getLeaseItemsForLease: vi.fn() }));
vi.mock('../../api/leaseByCustomDomain', () => ({ queryLeaseByCustomDomain: vi.fn() }));
vi.mock('../../api/billingParams', () => ({
  getReservedDomainSuffixes: vi.fn().mockResolvedValue([]),
  invalidateReservedDomainSuffixesCache: vi.fn(),
}));
vi.mock('../../api/tx', () => ({
  setItemCustomDomain: vi.fn(),
}));
vi.mock('../../utils/errors', () => ({ logError: vi.fn() }));

import { getLeaseItemsForLease } from '../../api/leaseItems';
import { queryLeaseByCustomDomain } from '../../api/leaseByCustomDomain';
import { setItemCustomDomain } from '../../api/tx';

const ADDR = 'manifest1tenant';
const LEASE_UUID = 'lease-uuid-1';

function makeApp(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    name: 'myapp',
    leaseUuid: LEASE_UUID,
    size: 'micro',
    providerUuid: 'prov-1',
    providerUrl: 'https://prov.example',
    createdAt: 1,
    status: 'running',
    connection: { host: 'prov.example', fqdn: 'auto.barney0.manifest0.net' },
    ...overrides,
  };
}

function makeOptions(app: AppEntry): ToolExecutorOptions {
  return {
    clientManager: null,
    address: ADDR,
    appRegistry: makeRegistry([app]),
  };
}

describe('executeSetCustomDomain', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error when wallet not connected', async () => {
    const r = await executeSetCustomDomain(
      { app_name: 'x', custom_domain: 'a.example.com' },
      { clientManager: null, address: undefined, appRegistry: makeRegistry() },
    );
    expect(r.success).toBe(false);
  });

  it('rejects non-string custom_domain (number)', async () => {
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: 42 as unknown },
      makeOptions(makeApp()),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/must be a string/i);
  });

  it('rejects missing custom_domain', async () => {
    const r = await executeSetCustomDomain(
      { app_name: 'myapp' },
      makeOptions(makeApp()),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/must be a string/i);
  });

  it('returns a clean error when getLeaseItemsForLease throws', async () => {
    const app = makeApp();
    vi.mocked(getLeaseItemsForLease).mockRejectedValue(new Error('rpc unavailable'));
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: 'app.example.com' },
      makeOptions(app),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/lease items|try again/i);
  });

  it('returns error when app not found', async () => {
    const r = await executeSetCustomDomain(
      { app_name: 'missing', custom_domain: 'a.example.com' },
      { clientManager: null, address: ADDR, appRegistry: makeRegistry() },
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/no app/i);
  });

  it('returns error on invalid format', async () => {
    const app = makeApp();
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: '' } as any,
    ]);
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: 'not a domain' },
      makeOptions(app),
    );
    expect(r.success).toBe(false);
  });

  it('confirms single-service legacy lease with serviceName=""', async () => {
    const app = makeApp();
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: '' } as any,
    ]);
    vi.mocked(queryLeaseByCustomDomain).mockResolvedValue(null);
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: 'app.example.com' },
      makeOptions(app),
    );
    expect(r.success).toBe(true);
    if (r.success && r.requiresConfirmation) {
      expect(r.pendingAction.toolName).toBe('set_custom_domain');
      expect(r.pendingAction.args.serviceName).toBe('');
      expect(r.pendingAction.args.customDomain).toBe('app.example.com');
      expect(r.pendingAction.args.leaseUuid).toBe(LEASE_UUID);
      expect(r.pendingAction.args.expectedCnameTarget).toBe('auto.barney0.manifest0.net');
    } else {
      throw new Error('Expected requiresConfirmation');
    }
  });

  it('rejects multi-item legacy lease (no service_names)', async () => {
    const app = makeApp();
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: '' } as any,
      { skuUuid: 'sku-2', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: '' } as any,
    ]);
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: 'app.example.com' },
      makeOptions(app),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/predates per-service|multi-item|legacy/i);
  });

  it('requires service_name for multi-service stack', async () => {
    const app = makeApp();
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'web', customDomain: '' } as any,
      { skuUuid: 'sku-2', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'db', customDomain: '' } as any,
    ]);
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: 'app.example.com' },
      makeOptions(app),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toMatch(/multi-service|service_name/i);
      expect(r.error).toMatch(/web/);
      expect(r.error).toMatch(/db/);
    }
  });

  it('rejects single-item legacy lease when service_name is provided (even if it matches app name)', async () => {
    const app = makeApp();
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: '' } as any,
    ]);
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: 'app.example.com', service_name: 'myapp' },
      makeOptions(app),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/single-service|drop the service_name/i);
  });

  it('auto-selects the sole service for a single-service modern lease (no service_name needed)', async () => {
    const app = makeApp();
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'web', customDomain: '' } as any,
    ]);
    vi.mocked(queryLeaseByCustomDomain).mockResolvedValue(null);
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: 'app.example.com' },
      makeOptions(app),
    );
    expect(r.success).toBe(true);
    if (r.success && r.requiresConfirmation) {
      expect(r.pendingAction.args.serviceName).toBe('web');
    } else {
      throw new Error('Expected requiresConfirmation');
    }
  });

  it('rejects unknown service_name in stack', async () => {
    const app = makeApp();
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'web', customDomain: '' } as any,
    ]);
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: 'app.example.com', service_name: 'bogus' },
      makeOptions(app),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/not found/i);
  });

  it('uses connection.services[svc].instances[0].fqdn as expected CNAME target for stack', async () => {
    const app = makeApp({
      connection: {
        host: 'prov.example',
        services: {
          web: { instances: [{ fqdn: 'web-auto.barney0.manifest0.net' }] },
        },
      },
    });
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'web', customDomain: '' } as any,
    ]);
    vi.mocked(queryLeaseByCustomDomain).mockResolvedValue(null);
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: 'app.example.com', service_name: 'web' },
      makeOptions(app),
    );
    expect(r.success).toBe(true);
    if (r.success && r.requiresConfirmation) {
      expect(r.pendingAction.args.expectedCnameTarget).toBe('web-auto.barney0.manifest0.net');
      expect(r.pendingAction.args.serviceName).toBe('web');
    }
  });

  it('rejects clear when no domain currently set', async () => {
    const app = makeApp();
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: '' } as any,
    ]);
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: '' },
      makeOptions(app),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/no custom domain to clear/i);
  });

  it('rejects setting same value as current', async () => {
    const app = makeApp();
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: 'app.example.com' } as any,
    ]);
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: 'app.example.com' },
      makeOptions(app),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/already has/i);
  });

  it('rejects when domain attached to another lease', async () => {
    const app = makeApp();
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: '' } as any,
    ]);
    vi.mocked(queryLeaseByCustomDomain).mockResolvedValue({
      leaseUuid: 'OTHER-LEASE',
      serviceName: '',
      lease: {} as any,
    });
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: 'app.example.com' },
      makeOptions(app),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/already attached/i);
  });

  it('confirms clear when domain is currently set', async () => {
    const app = makeApp();
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: 'old.example.com' } as any,
    ]);
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: '' },
      makeOptions(app),
    );
    expect(r.success).toBe(true);
    if (r.success && r.requiresConfirmation) {
      expect(r.pendingAction.args.customDomain).toBe('');
      expect(r.pendingAction.args.currentDomain).toBe('old.example.com');
      expect(r.confirmationMessage).toMatch(/clear/i);
    }
  });
});

describe('executeConfirmedSetCustomDomain', () => {
  beforeEach(() => vi.clearAllMocks());

  const fakeClientManager = {} as CosmosClientManager;
  const fakeSigner = { getAccounts: vi.fn() };

  function options(): ToolExecutorOptions {
    return {
      clientManager: fakeClientManager,
      address: ADDR,
      getOfflineSigner: () => fakeSigner as any,
    };
  }

  it('returns error if wallet not connected', async () => {
    const r = await executeConfirmedSetCustomDomain(
      { app_name: 'a', leaseUuid: 'l', serviceName: '', customDomain: 'a.example.com' },
      fakeClientManager,
      { clientManager: null, address: undefined },
    );
    expect(r.success).toBe(false);
  });

  it('returns error if getOfflineSigner missing', async () => {
    const r = await executeConfirmedSetCustomDomain(
      { app_name: 'a', leaseUuid: 'l', serviceName: '', customDomain: 'a.example.com' },
      fakeClientManager,
      { clientManager: fakeClientManager, address: ADDR },
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/signer/i);
  });

  it('broadcasts setItemCustomDomain and returns displayCard on success', async () => {
    vi.mocked(setItemCustomDomain).mockResolvedValue({
      success: true,
      transactionHash: 'HASH123',
      events: [],
    });
    const r = await executeConfirmedSetCustomDomain(
      { app_name: 'myapp', leaseUuid: 'lu1', serviceName: 'web', customDomain: 'app.example.com', expectedCnameTarget: 'auto.foo' },
      fakeClientManager,
      options(),
    );
    expect(r.success).toBe(true);
    expect(setItemCustomDomain).toHaveBeenCalledWith(fakeSigner, ADDR, 'lu1', 'web', 'app.example.com');
    if (r.success && !r.requiresConfirmation) {
      expect(r.displayCard?.type).toBe('custom_domain');
      if (r.displayCard?.type === 'custom_domain') {
        expect(r.displayCard.data.fqdn).toBe('app.example.com');
        expect(r.displayCard.data.serviceName).toBe('web');
        expect(r.displayCard.data.expectedCnameTarget).toBe('auto.foo');
        expect(r.displayCard.data.appName).toBe('myapp');
        expect(r.displayCard.data.leaseUuid).toBe('lu1');
        expect(r.displayCard.data.expectedAddress).toBe(ADDR);
      }
    }
  });

  it('rejects non-string customDomain in the confirmed path', async () => {
    const r = await executeConfirmedSetCustomDomain(
      { app_name: 'myapp', leaseUuid: 'lu1', serviceName: '', customDomain: null },
      fakeClientManager,
      options(),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/must be a string/i);
  });

  it('uses ALIAS / ANAME / flattened wording in success message when warning is set (apex)', async () => {
    vi.mocked(setItemCustomDomain).mockResolvedValue({
      success: true,
      transactionHash: 'HASH-APEX',
      events: [],
    });
    const r = await executeConfirmedSetCustomDomain(
      {
        app_name: 'myapp', leaseUuid: 'lu1', serviceName: '', customDomain: 'example.com',
        expectedCnameTarget: 'auto.foo', warning: 'This is an apex domain...',
      },
      fakeClientManager,
      options(),
    );
    expect(r.success).toBe(true);
    if (r.success && !r.requiresConfirmation) {
      expect((r.data as { message: string }).message).toMatch(/ALIAS \/ ANAME \/ CNAME-flattened/i);
      expect((r.data as { is_apex: boolean }).is_apex).toBe(true);
    }
  });

  it('does not include displayCard when clearing', async () => {
    vi.mocked(setItemCustomDomain).mockResolvedValue({
      success: true,
      transactionHash: 'HASH456',
      events: [],
    });
    const r = await executeConfirmedSetCustomDomain(
      { app_name: 'myapp', leaseUuid: 'lu1', serviceName: '', customDomain: '' },
      fakeClientManager,
      options(),
    );
    expect(r.success).toBe(true);
    if (r.success && !r.requiresConfirmation) {
      expect(r.displayCard).toBeUndefined();
      expect(r.data).toMatchObject({ custom_domain: null });
    }
  });

  it('returns error on broadcast failure', async () => {
    vi.mocked(setItemCustomDomain).mockResolvedValue({
      success: false,
      error: 'reserved suffix',
    });
    const r = await executeConfirmedSetCustomDomain(
      { app_name: 'myapp', leaseUuid: 'lu1', serviceName: '', customDomain: 'a.example.com' },
      fakeClientManager,
      options(),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe('reserved suffix');
  });
});
