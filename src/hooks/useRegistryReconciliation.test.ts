import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, type FC } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('./useVisibilityPolling', () => ({
  useVisibilityPolling: vi.fn(),
}));

vi.mock('../api/billing', () => ({
  LeaseState: {
    LEASE_STATE_PENDING: 1,
    LEASE_STATE_ACTIVE: 2,
  },
  getLeasesByTenant: vi.fn(),
}));

vi.mock('../api/leaseItems', () => ({
  getLeaseItemsForLease: vi.fn(),
}));

vi.mock('../registry/appRegistry', () => ({
  getApps: vi.fn(),
  reconcileWithChain: vi.fn(),
  reconcileCustomDomainsWithChain: vi.fn(),
}));

vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

import { useRegistryReconciliation } from './useRegistryReconciliation';
import { useVisibilityPolling } from './useVisibilityPolling';
import { getLeasesByTenant, LeaseState } from '../api/billing';
import { getLeaseItemsForLease } from '../api/leaseItems';
import {
  getApps,
  reconcileCustomDomainsWithChain,
  reconcileWithChain,
  type AppEntry,
} from '../registry/appRegistry';
import { AI_TOOL_API_TIMEOUT_MS } from '../config/constants';
import { logError } from '../utils/errors';

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
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(getLeasesByTenant).mockImplementation(async (_address, state) =>
      state === LeaseState.LEASE_STATE_ACTIVE
        ? [{ uuid: 'lease-web', items: [] } as never]
        : []
    );
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([]);
    vi.mocked(getApps).mockReturnValue([makeApp()]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(address: string | undefined): Promise<void> {
    await act(async () => {
      root.render(createElement(Wrapper, { address }));
    });
  }

  function latestRefresh(): () => Promise<boolean | void> {
    const call = vi.mocked(useVisibilityPolling).mock.calls.at(-1);
    expect(call).toBeDefined();
    return call![0];
  }

  it('routes immediate repair through the poller and authoritative per-lease reads', async () => {
    const prior = [{ serviceName: 'web', customDomain: 'old.example.com' }];
    const app = makeApp({ customDomains: prior });
    vi.mocked(getApps).mockReturnValue([app]);
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { serviceName: 'web', customDomain: 'new.example.com' } as never,
    ]);

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
    // The list fixture intentionally has items: []; the observed domain must
    // come from getLeaseItemsForLease's authoritative single-lease query.
    expect(getLeaseItemsForLease).toHaveBeenCalledWith('lease-web');
    const observations = vi.mocked(reconcileCustomDomainsWithChain).mock.calls[0][1];
    expect(observations.get('lease-web')).toEqual({
      customDomains: [{ serviceName: 'web', customDomain: 'new.example.com' }],
      expectedLocalDomains: prior,
    });
  });

  it('skips a not-found single-lease result instead of clearing cached domains', async () => {
    const prior = [{ serviceName: 'web', customDomain: 'keep.example.com' }];
    vi.mocked(getApps).mockReturnValue([makeApp({ customDomains: prior })]);
    vi.mocked(getLeaseItemsForLease).mockResolvedValue(null);
    await render(ADDRESS);

    await latestRefresh()();

    const observations = vi.mocked(reconcileCustomDomainsWithChain).mock.calls[0][1];
    expect(observations.has('lease-web')).toBe(false);
  });

  it('skips a failed lease-item read without blocking a healthy observation', async () => {
    const api = makeApp({ name: 'api', leaseUuid: 'lease-api' });
    vi.mocked(getLeasesByTenant).mockImplementation(async (_address, state) =>
      state === LeaseState.LEASE_STATE_ACTIVE
        ? [{ uuid: 'lease-web' } as never, { uuid: 'lease-api' } as never]
        : []
    );
    vi.mocked(getLeaseItemsForLease).mockImplementation(async (leaseUuid) => {
      if (leaseUuid === 'lease-web') throw new Error('RPC unavailable');
      return [{ serviceName: 'api', customDomain: 'api.example.com' } as never];
    });
    vi.mocked(getApps).mockReturnValue([makeApp(), api]);
    await render(ADDRESS);

    await latestRefresh()();

    const observations = vi.mocked(reconcileCustomDomainsWithChain).mock.calls[0][1];
    expect(observations.has('lease-web')).toBe(false);
    expect(observations.get('lease-api')?.customDomains).toEqual([
      { serviceName: 'api', customDomain: 'api.example.com' },
    ]);
    expect(logError).toHaveBeenCalledWith(
      'useRegistryReconciliation.leaseItems',
      expect.objectContaining({ message: 'RPC unavailable' }),
    );
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

  it('reads the newest durable registry snapshot at the start of the next pass', async () => {
    const oldDomains = [{ serviceName: 'web', customDomain: 'old.example.com' }];
    const freshDomains = [{ serviceName: 'web', customDomain: 'fresh.example.com' }];
    const oldApp = makeApp({ customDomains: oldDomains, chainState: 'pending' });
    const freshApp = { ...oldApp, customDomains: freshDomains, chainState: 'active' as const };
    vi.mocked(getApps).mockReturnValue([oldApp]);
    await render(ADDRESS);
    vi.mocked(getApps).mockReturnValue([freshApp]);

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

  it('skips a stalled lease-item read after its deadline instead of killing the pass', async () => {
    vi.useFakeTimers();
    vi.mocked(getLeaseItemsForLease).mockImplementation(() => new Promise(() => undefined));
    await render(ADDRESS);

    const stalled = latestRefresh()();
    const pending = Symbol('pending');
    let outcome: boolean | void | symbol = pending;
    void stalled.then((value) => { outcome = value; });
    await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS + 1);
    expect(outcome).not.toBe(pending);
    await stalled;

    expect(reconcileWithChain).toHaveBeenCalledOnce();
    const observations = vi.mocked(reconcileCustomDomainsWithChain).mock.calls[0][1];
    expect(observations.size).toBe(0);
    expect(logError).toHaveBeenCalledWith(
      'useRegistryReconciliation.leaseItems',
      expect.objectContaining({ message: expect.stringContaining('timed out') }),
    );
  });

  it('caps total single-lease reads per pass and rotates through larger registries', async () => {
    const apps = Array.from({ length: 6 }, (_, index) => makeApp({
      name: `app-${index}`,
      leaseUuid: `lease-${index}`,
    }));
    vi.mocked(getLeasesByTenant).mockImplementation(async (_address, state) =>
      state === LeaseState.LEASE_STATE_ACTIVE
        ? apps.map((app) => ({ uuid: app.leaseUuid } as never))
        : []
    );
    vi.mocked(getApps).mockReturnValue(apps);
    await render(ADDRESS);

    await latestRefresh()();
    expect(vi.mocked(getLeaseItemsForLease).mock.calls.map(([leaseUuid]) => leaseUuid))
      .toEqual(['lease-0', 'lease-1', 'lease-2', 'lease-3']);

    vi.mocked(getLeaseItemsForLease).mockClear();
    await latestRefresh()();
    expect(vi.mocked(getLeaseItemsForLease).mock.calls.map(([leaseUuid]) => leaseUuid))
      .toEqual(['lease-4', 'lease-5', 'lease-0', 'lease-1']);
  });
});
