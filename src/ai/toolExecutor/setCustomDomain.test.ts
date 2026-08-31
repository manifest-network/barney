import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeSetCustomDomain,
  executeConfirmedSetCustomDomain,
} from './compositeTransactions';
import type { ToolExecutorOptions } from './types';
import type { AppEntry } from '../../registry/appRegistry';
import type { CosmosClientManager } from '@manifest-network/manifest-sdk';
import { makeRegistry } from './testHelpers';

// External module mocks
vi.mock('../../api/leaseItems', () => ({ getLeaseItemsForLease: vi.fn() }));
vi.mock('../../api/leaseByCustomDomain', () => ({ queryLeaseByCustomDomain: vi.fn() }));
vi.mock('../../api/billingParams', () => ({
  getReservedDomainSuffixes: vi.fn().mockResolvedValue([]),
  invalidateReservedDomainSuffixesCache: vi.fn(),
}));
vi.mock('@manifest-network/manifest-sdk/deploy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@manifest-network/manifest-sdk/deploy')>()),
  setItemCustomDomain: vi.fn(),
}));
vi.mock('../../utils/errors', () => ({ logError: vi.fn() }));

import { getLeaseItemsForLease } from '../../api/leaseItems';
import { queryLeaseByCustomDomain } from '../../api/leaseByCustomDomain';
import {
  asFqdn,
  asLeaseUuid,
} from '@manifest-network/manifest-sdk';
import { setItemCustomDomain } from '@manifest-network/manifest-sdk/deploy';
import type { SetItemCustomDomainResult } from '@manifest-network/manifest-sdk/deploy';

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
    tiers: [],
  };
}

describe('executeSetCustomDomain', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error when wallet not connected', async () => {
    const r = await executeSetCustomDomain(
      { app_name: 'x', custom_domain: 'a.example.com' },
      { clientManager: null, address: undefined, appRegistry: makeRegistry(), tiers: [] },
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
      { clientManager: null, address: ADDR, appRegistry: makeRegistry(), tiers: [] },
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

  it('rejects when domain is held by a different service in the SAME lease', async () => {
    const app = makeApp();
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'web', customDomain: '' } as any,
      { skuUuid: 'sku-2', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'api', customDomain: '' } as any,
    ]);
    vi.mocked(queryLeaseByCustomDomain).mockResolvedValue({
      leaseUuid: LEASE_UUID,           // SAME lease
      serviceName: 'web',              // DIFFERENT service
      lease: {} as any,
    });
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: 'app.example.com', service_name: 'api' },
      makeOptions(app),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toMatch(/already attached/i);
      expect(r.error).toMatch(/web/);
      expect(r.error).toMatch(/clear it from there first/i);
    }
  });

  it('mentions "this app" when the holding service has an empty name (legacy)', async () => {
    const app = makeApp();
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: 'web', customDomain: '' } as any,
    ]);
    vi.mocked(queryLeaseByCustomDomain).mockResolvedValue({
      leaseUuid: LEASE_UUID,
      serviceName: '',
      lease: {} as any,
    });
    const r = await executeSetCustomDomain(
      { app_name: 'myapp', custom_domain: 'app.example.com', service_name: 'web' },
      makeOptions(app),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toMatch(/already attached to this app/i);
    }
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
  afterEach(() => vi.useRealTimers());

  const fakeClientManager = {} as CosmosClientManager;

  function options(): ToolExecutorOptions {
    return {
      clientManager: fakeClientManager,
      address: ADDR,
      tiers: [],
    };
  }

  function monoResult(overrides: Partial<{ lease_uuid: string; service_name: string; custom_domain: string; transactionHash: string; code: number }> = {}): SetItemCustomDomainResult {
    const base = {
      lease_uuid: 'lu1',
      service_name: '',
      custom_domain: 'app.example.com',
      transactionHash: 'HASH123',
      code: 0,
      confirmed: true, // 0.19.0: SetItemCustomDomainResult carries the broadcast-confirmation flag (ENG-494)
      ...overrides,
    };
    // core@0.15's SetItemCustomDomainResult brands lease_uuid/custom_domain
    // (LeaseUuid/Fqdn). asLeaseUuid/asFqdn are identity casts at runtime, so
    // downstream value-equality assertions are unaffected.
    return {
      ...base,
      lease_uuid: asLeaseUuid(base.lease_uuid),
      custom_domain: asFqdn(base.custom_domain),
    };
  }

  // core@0.15 setItemCustomDomain is (ctx, input, opts?). The domain/serviceName/
  // clear intent now lives in the input object at arg index 1 (was positional
  // args 2/3/opts). Brand casts are identity at runtime, so captured values are
  // the plain strings passed in.
  function capturedInput(callIndex = 0) {
    return vi.mocked(setItemCustomDomain).mock.calls[callIndex][1] as {
      leaseUuid: string;
      customDomain?: string;
      serviceName?: string;
      clear?: boolean;
    };
  }

  // ctx is arg 0: core@0.15 wants a TxCtx ({ chain, logger }) built over the
  // clientManager (was the bare clientManager positional).
  function capturedCtx(callIndex = 0) {
    return vi.mocked(setItemCustomDomain).mock.calls[callIndex][0];
  }

  it('returns error if wallet not connected', async () => {
    const r = await executeConfirmedSetCustomDomain(
      { app_name: 'a', leaseUuid: 'l', serviceName: '', customDomain: 'a.example.com' },
      fakeClientManager,
      { clientManager: null, address: undefined, tiers: [] },
    );
    expect(r.success).toBe(false);
  });

  it('delegates to mono setItemCustomDomain and returns displayCard on success', async () => {
    vi.mocked(setItemCustomDomain).mockResolvedValue(monoResult({ service_name: 'web' }));
    const r = await executeConfirmedSetCustomDomain(
      { app_name: 'myapp', leaseUuid: 'lu1', serviceName: 'web', customDomain: 'app.example.com', expectedCnameTarget: 'auto.foo' },
      fakeClientManager,
      options(),
    );
    expect(r.success).toBe(true);
    expect(setItemCustomDomain).toHaveBeenCalledTimes(1);
    expect(capturedCtx()).toMatchObject({ chain: fakeClientManager });
    expect(capturedCtx()).toHaveProperty('logger');
    const input = capturedInput();
    expect(input.leaseUuid).toBe('lu1');
    expect(input.customDomain).toBe('app.example.com');
    expect(input.serviceName).toBe('web');
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

  it('passes clear: true when customDomain is empty', async () => {
    vi.mocked(setItemCustomDomain).mockResolvedValue(monoResult({ custom_domain: '' }));
    const r = await executeConfirmedSetCustomDomain(
      { app_name: 'myapp', leaseUuid: 'lu1', serviceName: '', customDomain: '' },
      fakeClientManager,
      options(),
    );
    expect(r.success).toBe(true);
    const input = capturedInput();
    expect(input.leaseUuid).toBe('lu1');
    expect(input.clear).toBe(true);
    // clear arm carries no customDomain (discriminated union).
    expect(input.customDomain).toBeUndefined();
  });

  it('does not pass serviceName option when empty (legacy 1-item lease)', async () => {
    vi.mocked(setItemCustomDomain).mockResolvedValue(monoResult());
    await executeConfirmedSetCustomDomain(
      { app_name: 'myapp', leaseUuid: 'lu1', serviceName: '', customDomain: 'a.example.com' },
      fakeClientManager,
      options(),
    );
    // serviceName omitted from the input object when empty (legacy 1-item lease).
    expect(capturedInput().serviceName).toBeUndefined();
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
    vi.mocked(setItemCustomDomain).mockResolvedValue(monoResult({ custom_domain: 'example.com', transactionHash: 'HASH-APEX' }));
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
    vi.mocked(setItemCustomDomain).mockResolvedValue(monoResult({ custom_domain: '', transactionHash: 'HASH456' }));
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

  it('returns error when mono helper throws (validation or network)', async () => {
    vi.mocked(setItemCustomDomain).mockRejectedValue(new Error('reserved suffix'));
    const r = await executeConfirmedSetCustomDomain(
      { app_name: 'myapp', leaseUuid: 'lu1', serviceName: '', customDomain: 'a.example.com' },
      fakeClientManager,
      options(),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe('reserved suffix');
  });

  it('waits for confirmation before updating the registry and threads the chat signal', async () => {
    const app = makeApp({ customDomains: [] });
    const registry = makeRegistry([app]);
    const controller = new AbortController();
    let finish!: (result: SetItemCustomDomainResult) => void;
    vi.mocked(setItemCustomDomain).mockImplementationOnce(
      (_ctx, _input, callOptions) => new Promise((resolve, reject) => {
        finish = resolve;
        if (callOptions?.waitForConfirmation !== true) {
          reject(new Error('executor did not request confirmation'));
          return;
        }
        const passedSignal = (callOptions as { signal?: AbortSignal } | undefined)?.signal;
        if (passedSignal !== controller.signal) {
          reject(new Error('executor did not thread the chat signal'));
        }
      }),
    );

    const executing = executeConfirmedSetCustomDomain(
      {
        app_name: app.name,
        leaseUuid: app.leaseUuid,
        serviceName: 'web',
        customDomain: 'app.example.com',
      },
      fakeClientManager,
      { ...options(), appRegistry: registry, signal: controller.signal },
    );
    await Promise.resolve();
    expect(registry.updateApp).not.toHaveBeenCalled();
    finish(monoResult({ lease_uuid: app.leaseUuid, service_name: 'web' }));
    const r = await executing;

    expect(r.success).toBe(true);
    expect(vi.mocked(setItemCustomDomain).mock.calls[0][2]).toEqual({
      waitForConfirmation: true,
      signal: controller.signal,
    });
    expect(registry.updateApp).toHaveBeenCalledWith(ADDR, app.leaseUuid, {
      customDomains: [{ serviceName: 'web', customDomain: 'app.example.com' }],
    });
  });

  it('lets Stop cancel the SDK before a domain transaction is submitted', async () => {
    const app = makeApp({ customDomains: [] });
    const registry = makeRegistry([app]);
    const controller = new AbortController();
    vi.mocked(setItemCustomDomain).mockImplementationOnce(
      (_ctx, _input, callOptions) => new Promise((_resolve, reject) => {
        const passedSignal = (callOptions as { signal?: AbortSignal } | undefined)?.signal;
        passedSignal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        }, { once: true });
      }),
    );

    const executing = executeConfirmedSetCustomDomain(
      {
        app_name: app.name,
        leaseUuid: app.leaseUuid,
        serviceName: 'web',
        customDomain: 'app.example.com',
      },
      fakeClientManager,
      { ...options(), appRegistry: registry, signal: controller.signal },
    );
    controller.abort();
    const result = await executing;

    expect(result.success).toBe(false);
    expect(result.error).toContain('aborted');
    expect(vi.mocked(setItemCustomDomain).mock.calls[0][2]).toMatchObject({
      waitForConfirmation: true,
      signal: controller.signal,
    });
    expect(registry.updateApp).not.toHaveBeenCalled();
  });

  it('returns error when mono helper resolves with non-zero code (chain rejection)', async () => {
    vi.mocked(setItemCustomDomain).mockResolvedValue(monoResult({ code: 5 }));
    const r = await executeConfirmedSetCustomDomain(
      { app_name: 'myapp', leaseUuid: 'lu1', serviceName: '', customDomain: 'a.example.com' },
      fakeClientManager,
      options(),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/code 5/);
  });
});
