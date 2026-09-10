import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, type FC } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { AIStoreContext } from '../contexts/aiStoreContext';
import type { AIStore } from '../stores/aiStore';

vi.mock('./useVisibilityPolling', () => ({
  useVisibilityPolling: vi.fn(),
}));

vi.mock('../api/appDiscovery', async original => ({
  ...await original<typeof import('../api/appDiscovery')>(),
  discoverTenantApps: vi.fn().mockResolvedValue([]),
  hydrateDiscoveredApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../api/sku', () => ({ getProviders: vi.fn(), getSKUs: vi.fn() }));

vi.mock('../api/billing', () => ({
  LeaseState: {
    LEASE_STATE_PENDING: 1,
    LEASE_STATE_ACTIVE: 2,
  },
  getLeasesByTenant: vi.fn(),
}));

vi.mock('../registry/appRegistry', async original => ({
  ...await original<typeof import('../registry/appRegistry')>(),
  getApps: vi.fn(),
  reconcileWithChain: vi.fn(),
  reconcileCustomDomainsWithChain: vi.fn(),
}));

vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

import { useRegistryReconciliation } from './useRegistryReconciliation';
import { discoverTenantApps, hydrateDiscoveredApp } from '../api/appDiscovery';
import { useVisibilityPolling } from './useVisibilityPolling';
import { getLeasesByTenant, LeaseState, type Lease } from '../api/billing';
import { getProviders, getSKUs, type Provider, type SKU } from '../api/sku';
import {
  getApps,
  reconcileCustomDomainsWithChain,
  reconcileWithChain,
  type AppEntry,
} from '../registry/appRegistry';
import { AI_TOOL_API_TIMEOUT_MS, REGISTRY_RECONCILIATION_TIMEOUT_MS } from '../config/constants';

const ADDRESS = 'manifest1registry';

function makeApp(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    name: 'web',
    leaseUuid: 'lease-web',
    size: 'small',
    providerUuid: 'provider-1',
    providerUrl: 'https://fred.example.com',
    createdAt: 1,
    status: 'running',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const Wrapper: FC<{ address?: string }> = ({ address }) => {
  useRegistryReconciliation(address);
  return null;
};

describe('useRegistryReconciliation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(getLeasesByTenant).mockImplementation(async (_address, state) =>
      state === LeaseState.LEASE_STATE_ACTIVE
        ? [{ uuid: 'lease-web', items: [] } as never]
        : []
    );
    vi.mocked(getApps).mockReturnValue([makeApp()]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(address: string | undefined, store?: StoreApi<AIStore>): Promise<void> {
    await act(async () => {
      const child = createElement(Wrapper, { address });
      root.render(store ? createElement(AIStoreContext.Provider, { value: store }, child) : child);
    });
  }

  function latestRefresh(): () => Promise<boolean | void> {
    const call = vi.mocked(useVisibilityPolling).mock.calls.at(-1);
    expect(call).toBeDefined();
    return call![0];
  }

  async function configureRealDiscovery() {
    const discovery = await vi.importActual<typeof import('../api/appDiscovery')>('../api/appDiscovery');
    const registry = await vi.importActual<typeof import('../registry/appRegistry')>('../registry/appRegistry');
    vi.mocked(getApps).mockImplementation(registry.getApps);
    vi.mocked(discoverTenantApps).mockImplementationOnce((address, leases, options) =>
      discovery.discoverTenantApps(address, leases, { ...options, registry }),
    );
    return registry;
  }

  function discoveredLease(): Lease {
    return {
      uuid: 'lease-web',
      tenant: ADDRESS,
      providerUuid: 'provider-1',
      state: LeaseState.LEASE_STATE_ACTIVE,
      createdAt: new Date('2026-09-01T12:00:00Z'),
      items: [{ skuUuid: 'sku-1', serviceName: 'web', customDomain: 'web.example.com' }],
    } as Lease;
  }

  it('routes immediate repair through the poller and consumes lease-list items', async () => {
    const prior = [{ serviceName: 'web', customDomain: 'old.example.com' }];
    const app = makeApp({ customDomains: prior });
    vi.mocked(getApps).mockReturnValue([app]);
    vi.mocked(getLeasesByTenant).mockImplementation(async (_address, state) =>
      state === LeaseState.LEASE_STATE_ACTIVE
        ? [{
            uuid: 'lease-web',
            items: [{ serviceName: 'web', customDomain: 'new.example.com' }],
          } as never]
        : []
    );

    await render(ADDRESS);

    // No direct mount effect may bypass the poller's hidden/in-flight guards.
    expect(getApps).not.toHaveBeenCalled();
    expect(getLeasesByTenant).not.toHaveBeenCalled();
    expect(useVisibilityPolling).toHaveBeenCalledWith(
      expect.any(Function),
      15_000,
      expect.objectContaining({
        enabled: true,
        immediate: true,
        backoff: true,
        restartKey: ADDRESS,
      }),
    );

    await latestRefresh()();

    expect(getLeasesByTenant).toHaveBeenCalledWith(ADDRESS, LeaseState.LEASE_STATE_ACTIVE);
    expect(getLeasesByTenant).toHaveBeenCalledWith(ADDRESS, LeaseState.LEASE_STATE_PENDING);
    expect(reconcileWithChain).toHaveBeenCalledWith(
      ADDRESS,
      new Map([['lease-web', 'active']]),
      new Map([['lease-web', undefined]]),
    );
    const observations = vi.mocked(reconcileCustomDomainsWithChain).mock.calls[0][1];
    expect(observations.get('lease-web')).toEqual({
      customDomains: [{ serviceName: 'web', customDomain: 'new.example.com' }],
      expectedLocalDomains: prior,
    });
  });

  it('captures the concurrency baseline before the lease-list RPC settles', async () => {
    const active = deferred<never[]>();
    vi.mocked(getLeasesByTenant).mockImplementation((_address, state) =>
      state === LeaseState.LEASE_STATE_ACTIVE ? active.promise : Promise.resolve([])
    );
    const oldDomains = [{ serviceName: 'web', customDomain: 'old.example.com' }];
    const freshDomains = [{ serviceName: 'web', customDomain: 'fresh.example.com' }];
    const oldApp = makeApp({ customDomains: oldDomains, chainState: 'pending' });
    vi.mocked(getApps).mockReturnValue([oldApp]);
    await render(ADDRESS);

    const refreshing = latestRefresh()();
    await vi.waitFor(() => expect(getLeasesByTenant).toHaveBeenCalledTimes(2));
    vi.mocked(getApps).mockReturnValue([
      { ...oldApp, customDomains: freshDomains, chainState: 'active' },
    ]);
    active.resolve([{ uuid: 'lease-web' } as never]);
    await refreshing;

    expect(reconcileWithChain).toHaveBeenCalledWith(
      ADDRESS,
      new Map([['lease-web', 'active']]),
      new Map([['lease-web', 'pending']]),
    );
    const observations = vi.mocked(reconcileCustomDomainsWithChain).mock.calls[0][1];
    expect(observations.get('lease-web')?.expectedLocalDomains).toBe(oldDomains);
  });

  it('does not produce an empty-domain observation for a lease that is no longer live', async () => {
    const prior = [{ serviceName: 'web', customDomain: 'keep.example.com' }];
    vi.mocked(getApps).mockReturnValue([makeApp({ customDomains: prior })]);
    vi.mocked(getLeasesByTenant).mockResolvedValue([]);
    await render(ADDRESS);

    await latestRefresh()();

    const observations = vi.mocked(reconcileCustomDomainsWithChain).mock.calls[0][1];
    expect(observations.has('lease-web')).toBe(false);
    expect(observations.size).toBe(0);
  });

  it('reads the newest durable registry snapshot at the start of the next pass', async () => {
    const oldDomains = [{ serviceName: 'web', customDomain: 'old.example.com' }];
    const freshDomains = [{ serviceName: 'web', customDomain: 'fresh.example.com' }];
    const oldApp = makeApp({ customDomains: oldDomains, chainState: 'pending' });
    const freshApp = { ...oldApp, customDomains: freshDomains, chainState: 'active' as const };
    vi.mocked(getApps).mockReturnValue([oldApp]);
    await render(ADDRESS);

    await latestRefresh()();
    expect(reconcileWithChain).toHaveBeenLastCalledWith(
      ADDRESS,
      expect.any(Map),
      new Map([['lease-web', 'pending']]),
    );
    expect(vi.mocked(reconcileCustomDomainsWithChain).mock.calls.at(-1)?.[1]
      .get('lease-web')?.expectedLocalDomains).toBe(oldDomains);

    vi.mocked(getApps).mockReturnValue([freshApp]);
    vi.mocked(reconcileWithChain).mockClear();
    vi.mocked(reconcileCustomDomainsWithChain).mockClear();

    await latestRefresh()();

    expect(reconcileWithChain).toHaveBeenCalledWith(
      ADDRESS,
      expect.any(Map),
      new Map([['lease-web', 'active']]),
    );
    const observations = vi.mocked(reconcileCustomDomainsWithChain).mock.calls[0][1];
    expect(observations.get('lease-web')?.expectedLocalDomains).toBe(freshDomains);
  });

  it('returns after a stalled lease-list deadline so a later pass can run', async () => {
    vi.useFakeTimers();
    vi.mocked(getLeasesByTenant).mockImplementation(() => new Promise(() => undefined));
    await render(ADDRESS);

    const stalled = latestRefresh()();
    const pending = Symbol('pending');
    let outcome: boolean | void | symbol = pending;
    void stalled.then((value) => { outcome = value; });
    await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS + 1);
    expect(outcome).toBe(false);
    await stalled;
    expect(reconcileWithChain).not.toHaveBeenCalled();

    vi.mocked(getLeasesByTenant).mockImplementation(async (_address, state) =>
      state === LeaseState.LEASE_STATE_ACTIVE ? [{ uuid: 'lease-web' } as never] : []
    );
    await expect(latestRefresh()()).resolves.toBeUndefined();
    expect(reconcileWithChain).toHaveBeenCalledOnce();
  });

  it('reconciles a larger registry with only the two tenant-list reads', async () => {
    const apps = Array.from({ length: 6 }, (_, index) => makeApp({
      name: `app-${index}`,
      leaseUuid: `lease-${index}`,
    }));
    vi.mocked(getLeasesByTenant).mockImplementation(async (_address, state) =>
      state === LeaseState.LEASE_STATE_ACTIVE
        ? apps.map((app, index) => ({
            uuid: app.leaseUuid,
            items: [{
              serviceName: app.name,
              customDomain: `app-${index}.example.com`,
            }],
          } as never))
        : []
    );
    vi.mocked(getApps).mockReturnValue(apps);
    await render(ADDRESS);

    await latestRefresh()();
    expect(getLeasesByTenant).toHaveBeenCalledTimes(2);
    const observations = vi.mocked(reconcileCustomDomainsWithChain).mock.calls[0][1];
    expect(observations.size).toBe(6);
    expect(observations.get('lease-5')?.customDomains).toEqual([
      { serviceName: 'app-5', customDomain: 'app-5.example.com' },
    ]);
  });

  it('discovers wallet leases when the browser registry is empty', async () => {
    vi.mocked(getApps).mockReturnValue([]);
    await render(ADDRESS);
    await latestRefresh()();

    expect(discoverTenantApps).toHaveBeenCalledWith(
      ADDRESS,
      [{ uuid: 'lease-web', items: [] }],
      { signal: expect.any(AbortSignal) },
    );
    expect(hydrateDiscoveredApp).not.toHaveBeenCalled();
  });

  it('discards a lease read that finishes after switching wallets', async () => {
    const leases = deferred<never[]>();
    vi.mocked(getLeasesByTenant).mockReturnValue(leases.promise);
    await render(ADDRESS);
    const refreshing = latestRefresh()();
    await render('manifest1different');
    leases.resolve([{ uuid: 'old-wallet-lease' } as never]);
    await refreshing;

    expect(discoverTenantApps).not.toHaveBeenCalled();
    expect(reconcileWithChain).not.toHaveBeenCalled();
  });

  it('keeps chain refreshes independent of provider recovery even with a signer', async () => {
    const signing = { authTokens: {} } as AIStore['signing'];
    const store = createStore<AIStore>(() => ({ address: ADDRESS, signing, authorizationEpoch: 1 }) as AIStore);
    vi.mocked(getApps).mockReturnValue([makeApp({ provisionState: 'unconfirmed' })]);
    await render(ADDRESS, store);
    await latestRefresh()();
    await latestRefresh()();

    expect(reconcileWithChain).toHaveBeenCalledTimes(2);
    expect(hydrateDiscoveredApp).not.toHaveBeenCalled();
  });

  it('imports apps when successful sequential lease and catalog stages exceed one API interval', async () => {
    const registry = await configureRealDiscovery();
    vi.useFakeTimers();
    const chain = deferred<Lease[]>();
    const providers = deferred<Provider[]>();
    const skus = deferred<SKU[]>();
    vi.mocked(getLeasesByTenant).mockReturnValue(chain.promise);
    vi.mocked(getProviders).mockReturnValueOnce(providers.promise);
    vi.mocked(getSKUs).mockReturnValueOnce(skus.promise);
    await render(ADDRESS);

    const refreshing = latestRefresh()();
    // With the default configuration, tenant reads take 10s and catalogs 6s.
    await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS * 2 / 3);
    chain.resolve([discoveredLease()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(getProviders).toHaveBeenCalledWith(false);
    expect(getSKUs).toHaveBeenCalledWith(false);
    expect(reconcileWithChain).toHaveBeenCalledOnce();
    expect(reconcileCustomDomainsWithChain).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS * 2 / 5);
    providers.resolve([{ uuid: 'provider-1', apiUrl: 'https://fred.example.com' } as Provider]);
    skus.resolve([{ uuid: 'sku-1', providerUuid: 'provider-1', name: 'small' } as SKU]);

    await expect(refreshing).resolves.toBeUndefined();
    expect(registry.getAppByLease(ADDRESS, 'lease-web')).toMatchObject({
      providerUrl: 'https://fred.example.com',
      size: 'small',
      chainState: 'active',
      provisionState: 'unconfirmed',
      status: 'deploying',
      customDomains: [{ serviceName: 'web', customDomain: 'web.example.com' }],
    });
  });

  it('imports fallback inventory after stalled catalogs exhaust their own allowance and ignores late results', async () => {
    const registry = await configureRealDiscovery();
    vi.useFakeTimers();
    const chain = deferred<Lease[]>();
    const providers = deferred<Provider[]>();
    const skus = deferred<SKU[]>();
    vi.mocked(getLeasesByTenant).mockReturnValue(chain.promise);
    vi.mocked(getProviders).mockReturnValueOnce(providers.promise);
    vi.mocked(getSKUs).mockReturnValueOnce(skus.promise);
    await render(ADDRESS);

    const refreshing = latestRefresh()();
    await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS * 2 / 3);
    chain.resolve([discoveredLease()]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS - 1);
    expect(registry.getApps(ADDRESS)).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);

    await expect(refreshing).resolves.toBeUndefined();
    const recovered = registry.getAppByLease(ADDRESS, 'lease-web');
    expect(recovered).toMatchObject({
      providerUrl: '',
      size: 'unknown',
      chainState: 'active',
      provisionState: 'unconfirmed',
      status: 'deploying',
      customDomains: [{ serviceName: 'web', customDomain: 'web.example.com' }],
    });
    providers.resolve([{ uuid: 'provider-1', apiUrl: 'https://late.example.com' } as Provider]);
    skus.resolve([{ uuid: 'sku-1', providerUuid: 'provider-1', name: 'late-size' } as SKU]);
    await vi.advanceTimersByTimeAsync(REGISTRY_RECONCILIATION_TIMEOUT_MS);
    expect(registry.getAppByLease(ADDRESS, 'lease-web')).toEqual(recovered);
  });

  it('discards catalog results that finish after switching wallets', async () => {
    const registry = await configureRealDiscovery();
    const providers = deferred<Provider[]>();
    const skus = deferred<SKU[]>();
    vi.mocked(getLeasesByTenant).mockResolvedValue([discoveredLease()]);
    vi.mocked(getProviders).mockReturnValueOnce(providers.promise);
    vi.mocked(getSKUs).mockReturnValueOnce(skus.promise);
    await render(ADDRESS);

    const refreshing = latestRefresh()();
    await vi.waitFor(() => expect(getProviders).toHaveBeenCalledOnce());
    await render('manifest1different');
    await expect(refreshing).resolves.toBeUndefined();
    providers.resolve([{ uuid: 'provider-1', apiUrl: 'https://old-wallet.example.com' } as Provider]);
    skus.resolve([{ uuid: 'sku-1', providerUuid: 'provider-1', name: 'small' } as SKU]);
    await Promise.resolve();

    expect(registry.getApps(ADDRESS)).toEqual([]);
    expect(registry.getApps('manifest1different')).toEqual([]);
  });

  it('bounds chain and catalog reads together and allows the next refresh to run', async () => {
    vi.useFakeTimers();
    const chain = deferred<never[]>();
    vi.mocked(getLeasesByTenant).mockReturnValue(chain.promise);
    vi.mocked(discoverTenantApps).mockImplementationOnce(() => new Promise(() => undefined));
    await render(ADDRESS);

    const refreshing = latestRefresh()();
    await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS / 2);
    chain.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(discoverTenantApps).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(REGISTRY_RECONCILIATION_TIMEOUT_MS - AI_TOOL_API_TIMEOUT_MS / 2 + 1);
    await expect(refreshing).resolves.toBe(false);
    expect(vi.mocked(discoverTenantApps).mock.calls[0][2]!.signal!.aborted).toBe(true);

    vi.mocked(getLeasesByTenant).mockResolvedValue([]);
    await expect(latestRefresh()()).resolves.toBeUndefined();
    expect(reconcileWithChain).toHaveBeenCalledTimes(2);
  });
});
