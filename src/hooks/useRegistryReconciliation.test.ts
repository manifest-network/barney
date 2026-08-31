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
  reconcileCustomDomainsWithChain,
  reconcileWithChain,
  type AppEntry,
} from '../registry/appRegistry';
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

const Wrapper: FC<{ address?: string; apps: AppEntry[] }> = ({ address, apps }) => {
  useRegistryReconciliation(address, apps);
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('wires the recurring repair through authoritative per-lease item reads', async () => {
    const prior = [{ serviceName: 'web', customDomain: 'old.example.com' }];
    const app = makeApp({ customDomains: prior });
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { serviceName: 'web', customDomain: 'new.example.com' } as never,
    ]);

    await act(async () => {
      root.render(createElement(Wrapper, { address: ADDRESS, apps: [app] }));
    });
    await vi.waitFor(() => expect(reconcileCustomDomainsWithChain).toHaveBeenCalledOnce());

    expect(getLeasesByTenant).toHaveBeenCalledWith(ADDRESS, LeaseState.LEASE_STATE_ACTIVE);
    expect(getLeasesByTenant).toHaveBeenCalledWith(ADDRESS, LeaseState.LEASE_STATE_PENDING);
    expect(reconcileWithChain).toHaveBeenCalledWith(
      ADDRESS,
      new Map([['lease-web', 'active']]),
    );
    // The list fixture intentionally has items: []; the observed domain must
    // come from getLeaseItemsForLease's authoritative single-lease query.
    expect(getLeaseItemsForLease).toHaveBeenCalledWith('lease-web');
    const observations = vi.mocked(reconcileCustomDomainsWithChain).mock.calls[0][1];
    expect(observations.get('lease-web')).toEqual({
      customDomains: [{ serviceName: 'web', customDomain: 'new.example.com' }],
      expectedLocalDomains: prior,
    });
    expect(useVisibilityPolling).toHaveBeenCalledWith(
      expect.any(Function),
      15_000,
      expect.objectContaining({ enabled: true, immediate: false, backoff: true }),
    );
  });

  it('skips a failed lease-item read instead of treating it as an empty observation', async () => {
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

    await act(async () => {
      root.render(createElement(Wrapper, {
        address: ADDRESS,
        apps: [makeApp(), api],
      }));
    });
    await vi.waitFor(() => expect(reconcileCustomDomainsWithChain).toHaveBeenCalledOnce());

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
});
