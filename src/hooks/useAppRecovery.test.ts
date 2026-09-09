import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type FC } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { getLeaseConnectionInfo, getLeaseStatus } from '@manifest-network/manifest-sdk/deploy';
import { AIStoreContext } from '../contexts/aiStoreContext';
import type { AIStore } from '../stores/aiStore';
import type { SigningContext } from '../ai/toolExecutor/types';
import { LeaseState } from '../api/billing';
import * as registry from '../registry/appRegistry';
import type { AppEntry } from '../registry/appRegistry';
import { APP_RECOVERY_MAX_ATTEMPTS, APP_RECOVERY_TIMEOUT_MS, AUTO_REFRESH_INTERVAL_MS } from '../config/constants';
import { useAppRecovery } from './useAppRecovery';

vi.mock('../utils/errors', () => ({ logError: vi.fn() }));
vi.mock('@manifest-network/manifest-sdk/deploy', async original => ({
  ...await original<typeof import('@manifest-network/manifest-sdk/deploy')>(),
  getLeaseStatus: vi.fn(),
  getLeaseConnectionInfo: vi.fn(),
}));

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const PROVIDER_UUID = '550e8400-e29b-41d4-a716-446655440001';
const Wrapper: FC<{ address: string }> = ({ address }) => {
  useAppRecovery(address);
  return null;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('useAppRecovery', () => {
  let address: string;
  let sequence = 0;
  let container: HTMLDivElement;
  let root: Root;
  let store: StoreApi<AIStore>;
  let getAuthToken: ReturnType<typeof vi.fn>;

  function addApp(overrides: Partial<AppEntry> = {}) {
    return registry.addApp(address, {
      name: 'app', leaseUuid: LEASE_UUID, providerUuid: PROVIDER_UUID,
      providerUrl: 'https://provider.example.com', createdAt: 1, size: 'small',
      status: 'deploying', chainState: 'active', provisionState: 'unconfirmed',
      ...overrides,
    });
  }

  async function render() {
    await act(async () => {
      root.render(createElement(AIStoreContext.Provider, { value: store }, createElement(Wrapper, { address })));
    });
  }

  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    address = `manifest1recovery${++sequence}`;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    getAuthToken = vi.fn().mockResolvedValue('token');
    store = createStore<AIStore>(() => ({
      address,
      signing: { authTokens: { getAuthToken } } as unknown as SigningContext,
      authorizationEpoch: 0,
      isStreaming: false,
      activeTransactionMessageId: null,
      pendingConfirmation: null,
    } as AIStore));
    vi.mocked(getLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'ready' });
    vi.mocked(getLeaseConnectionInfo).mockImplementation(async (_url, leaseUuid) => ({
      lease_uuid: leaseUuid, tenant: address, provider_uuid: PROVIDER_UUID,
      connection: { host: '', fqdn: 'app.example.com' },
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('picks up newly discovered registry inventory and uses two separate tokens per app', async () => {
    await render();
    expect(getAuthToken).not.toHaveBeenCalled();
    addApp();
    addApp({ name: 'second', leaseUuid: '550e8400-e29b-41d4-a716-446655440002' });
    getAuthToken.mockResolvedValueOnce('status-1').mockResolvedValueOnce('connection-1')
      .mockResolvedValueOnce('status-2').mockResolvedValueOnce('connection-2');
    await advance(1_000);
    expect(getAuthToken).toHaveBeenCalledTimes(2);
    await advance(1_000);
    expect(getAuthToken).toHaveBeenCalledTimes(4);
    expect(vi.mocked(getLeaseStatus).mock.calls.map(call => call[2])).toEqual(['status-1', 'status-2']);
    expect(vi.mocked(getLeaseConnectionInfo).mock.calls.map(call => call[2])).toEqual(['connection-1', 'connection-2']);
    expect(registry.getApps(address).every(app => app.status === 'running')).toBe(true);
  });

  it.each([false, true])('retires ready empty endpoint inventories, including blocked storage: %s', async blockedStorage => {
    if (blockedStorage) vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    addApp();
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: LEASE_UUID, tenant: address, provider_uuid: PROVIDER_UUID,
      connection: { host: 'provider.example.com', ports: {}, protocol: 'https' },
    });
    await render();
    await advance(300_000);
    expect(getAuthToken).toHaveBeenCalledTimes(2);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ status: 'running', connection: { ports: {} } });
    expect(registry.getAppByLease(address, LEASE_UUID)?.url).toBeUndefined();
  });

  it('retires a provider failure even when the lease is still active on chain', async () => {
    addApp();
    vi.mocked(getLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'failing' });
    vi.mocked(getLeaseConnectionInfo).mockRejectedValue(new Error('unavailable'));
    await render();
    await advance(300_000);
    expect(getAuthToken).toHaveBeenCalledTimes(2);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ chainState: 'active', status: 'failed' });
  });

  it('backs off incomplete metadata without resetting its budget on its own registry writes', async () => {
    addApp();
    vi.mocked(getLeaseConnectionInfo).mockResolvedValueOnce({
      lease_uuid: LEASE_UUID, tenant: address, provider_uuid: PROVIDER_UUID, connection: { host: '' },
    });
    await render();
    expect(getAuthToken).toHaveBeenCalledTimes(2);
    await advance(AUTO_REFRESH_INTERVAL_MS - 1);
    expect(getAuthToken).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getAuthToken).toHaveBeenCalledTimes(4);
    expect(registry.getAppByLease(address, LEASE_UUID)?.url).toBe('https://app.example.com');
    await advance(300_000);
    expect(getAuthToken).toHaveBeenCalledTimes(4);
  });

  it('bounds repeated incomplete responses and permits externally refreshed metadata to recover', async () => {
    addApp();
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: LEASE_UUID, tenant: address, provider_uuid: PROVIDER_UUID, connection: { host: '' },
    });
    await render();
    await advance(300_000);
    expect(getAuthToken).toHaveBeenCalledTimes(APP_RECOVERY_MAX_ATTEMPTS * 2);
    await advance(300_000);
    expect(getAuthToken).toHaveBeenCalledTimes(APP_RECOVERY_MAX_ATTEMPTS * 2);
    registry.updateApp(address, LEASE_UUID, { providerUrl: 'https://replacement.example.com' });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: LEASE_UUID, tenant: address, provider_uuid: PROVIDER_UUID,
      connection: { host: '', fqdn: 'recovered.example.com' },
    });
    await advance(1_000);
    expect(registry.getAppByLease(address, LEASE_UUID)?.url).toBe('https://recovered.example.com');
  });

  it('preserves its retry budget when provider fields are stripped from persistent snapshots', async () => {
    addApp();
    vi.mocked(getLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'restarting' });
    let observation = 0;
    vi.mocked(getLeaseConnectionInfo).mockImplementation(async () => ({
      lease_uuid: LEASE_UUID, tenant: address, provider_uuid: PROVIDER_UUID,
      connection: { host: '', fqdn: `app-${++observation}.example.com`, protocol: 'https', metadata: { observation: String(observation) } },
    }));
    await render();
    await advance(300_000);
    expect(getAuthToken).toHaveBeenCalledTimes(APP_RECOVERY_MAX_ATTEMPTS * 2);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({
      provisionState: 'unconfirmed', url: `https://app-${APP_RECOVERY_MAX_ATTEMPTS}.example.com`,
    });
  });

  it('gives unattempted leases a turn before retrying an incomplete lease', async () => {
    addApp();
    addApp({ name: 'second', leaseUuid: '550e8400-e29b-41d4-a716-446655440002' });
    vi.mocked(getLeaseConnectionInfo).mockRejectedValue(new Error('unavailable'));
    await render();
    await advance(1_000);
    expect(vi.mocked(getLeaseStatus).mock.calls.map(call => call[1])).toEqual([
      LEASE_UUID, '550e8400-e29b-41d4-a716-446655440002',
    ]);
  });

  it('never queues more background signatures behind a nonabortable timed-out mint', async () => {
    addApp();
    addApp({ name: 'second', leaseUuid: '550e8400-e29b-41d4-a716-446655440002' });
    const pending = deferred<string>();
    getAuthToken.mockReturnValue(pending.promise);
    await render();
    await advance(APP_RECOVERY_TIMEOUT_MS + 300_000);
    expect(getAuthToken).toHaveBeenCalledTimes(1);
    getAuthToken.mockResolvedValue('fresh-token');
    pending.resolve('late-token');
    await advance(0);
    expect(getLeaseStatus).not.toHaveBeenCalled();
    expect(getLeaseConnectionInfo).not.toHaveBeenCalled();
    await advance(1_000);
    expect(getAuthToken).toHaveBeenCalledTimes(3);
    expect(registry.getAppByLease(address, '550e8400-e29b-41d4-a716-446655440002')?.status).toBe('running');
  });

  it.each([
    { isStreaming: true },
    { activeTransactionMessageId: 'tx' },
    { pendingConfirmation: {} as NonNullable<AIStore['pendingConfirmation']> },
  ])('yields authentication immediately to foreground work: %j', async busy => {
    addApp();
    const pending = deferred<string>();
    getAuthToken.mockReturnValueOnce(pending.promise);
    await render();
    await act(async () => { store.setState(busy); });
    pending.resolve('late-token');
    await advance(60_000);
    expect(getAuthToken).toHaveBeenCalledTimes(1);
    expect(getLeaseStatus).not.toHaveBeenCalled();
    expect(getLeaseConnectionInfo).not.toHaveBeenCalled();
  });

  it('drops observations after a same-address authorization change and starts a fresh recovery budget', async () => {
    addApp();
    const pending = deferred<Awaited<ReturnType<typeof getLeaseStatus>>>();
    vi.mocked(getLeaseStatus).mockReturnValueOnce(pending.promise);
    await render();
    await act(async () => { store.setState({ authorizationEpoch: 1 }); });
    pending.resolve({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'ready' });
    await advance(0);
    expect(registry.getAppByLease(address, LEASE_UUID)?.provisionState).toBe('unconfirmed');
    await advance(1_000);
    expect(registry.getAppByLease(address, LEASE_UUID)?.provisionState).toBe('confirmed');
  });
});
