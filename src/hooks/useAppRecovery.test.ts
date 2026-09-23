import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type FC } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { appStatus, getLeaseConnectionInfo, getLeaseStatus, restartApp, updateApp, waitForLeaseStatus } from '@manifest-network/manifest-sdk/deploy';
import type { CosmosClientManager } from '@manifest-network/manifest-sdk';
import { executeConfirmedRestartApp, executeConfirmedUpdateApp } from '../ai/toolExecutor/compositeTransactions';
import { executeAppStatus } from '../ai/toolExecutor/compositeQueries';
import { AIStoreContext } from '../contexts/aiStoreContext';
import type { AIStore } from '../stores/aiStore';
import type { SigningContext } from '../ai/toolExecutor/types';
import { LeaseState } from '../api/billing';
import * as registry from '../registry/appRegistry';
import type { AppEntry } from '../registry/appRegistry';
import { APP_CONNECTION_RECOVERY_INTERVAL_MS, APP_CONNECTION_RECOVERY_MAX_ATTEMPTS, APP_RECOVERY_MAX_ATTEMPTS, APP_RECOVERY_POLL_INTERVAL_MS, APP_RECOVERY_TIMEOUT_MS, AUTO_REFRESH_INTERVAL_MS } from '../config/constants';
import { useAppRecovery } from './useAppRecovery';

vi.mock('../utils/errors', async original => ({ ...await original<typeof import('../utils/errors')>(), logError: vi.fn() }));
vi.mock('@manifest-network/manifest-sdk/deploy', async original => ({
  ...await original<typeof import('@manifest-network/manifest-sdk/deploy')>(),
  getLeaseStatus: vi.fn(),
  getLeaseConnectionInfo: vi.fn(),
  appStatus: vi.fn(),
  restartApp: vi.fn(), updateApp: vi.fn(), waitForLeaseStatus: vi.fn(),
}));
vi.mock('../ai/toolExecutor/capabilityCtx', () => ({ buildBarneyCtx: vi.fn(async () => ({})) }));

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

  it('refreshes invalidated connection metadata even for a confirmed app with a saved URL', async () => {
    addApp({ provisionState: 'confirmed', url: 'https://new.example.com',
      connection: { host: '', fqdn: 'old.example.com' }, connectionStale: true });
    await render();
    expect(getLeaseConnectionInfo).toHaveBeenCalledTimes(1);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({
      connectionStale: false, connection: { fqdn: 'app.example.com' },
    });
    expect(getLeaseStatus).toHaveBeenCalledTimes(1);
    expect(getAuthToken).toHaveBeenCalledTimes(2);
  });

  it.each(['restart', 'batch restart', 'update'].flatMap(operation => ['timeout', 'abort'].map(reason => ({ operation, reason }))))('observes a later runtime failure after a legacy $operation wait $reason without retracting readiness first', async ({ operation, reason }) => {
    const app = addApp({ provisionState: 'confirmed', url: 'https://app.example.com',
      connection: { host: '', fqdn: 'app.example.com' }, connectionStale: false });
    await render();
    expect(getLeaseStatus).not.toHaveBeenCalled();
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: app.leaseUuid, status: 'restarting' });
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: app.leaseUuid, status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockRejectedValue(reason === 'abort'
      ? new DOMException('Wait cancelled after POST', 'AbortError') : new Error('Readiness wait timed out'));
    const entry = { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl };
    const chain = {} as CosmosClientManager;
    const options = { address, clientManager: chain, appRegistry: registry, signing: store.getState().signing!, tiers: [] };
    await act(async () => {
      if (operation === 'update') {
        const bytes = new TextEncoder().encode('{"image":"nginx:new"}');
        await executeConfirmedUpdateApp(entry, chain, options, { bytes, size: bytes.length, hash: 'test' });
      } else {
        await executeConfirmedRestartApp(operation === 'batch restart'
          ? { app_name: 'all', entries: [entry] } : entry, chain, options);
      }
    });
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ provisionState: 'confirmed', status: 'running', connectionStale: true, readinessStale: true });
    vi.mocked(getLeaseStatus).mockResolvedValueOnce({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'restarting' });
    await advance(APP_RECOVERY_POLL_INTERVAL_MS);
    expect(getLeaseStatus).toHaveBeenCalledTimes(1);
    // Fresh connection data restores DNS evidence while readiness checks continue.
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ provisionState: 'confirmed', connectionStale: false, readinessStale: true });
    vi.mocked(getLeaseStatus).mockResolvedValueOnce({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'failed' });
    await advance(AUTO_REFRESH_INTERVAL_MS);
    expect(getLeaseStatus).toHaveBeenCalledTimes(2);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ provisionState: 'failed', status: 'failed', readinessStale: false });
  });

  it('continues background observation after app_status refreshes a connection during maintenance', async () => {
    const app = addApp({ provisionState: 'confirmed', readinessStale: true, connectionStale: true,
      url: 'https://old.example.com', connection: { host: '', fqdn: 'old.example.com' } });
    vi.mocked(appStatus).mockResolvedValue({
      chainState: { state: LeaseState.LEASE_STATE_ACTIVE, items: [] },
      fredStatus: { state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'restarting' },
      connection: { host: '', fqdn: 'app.example.com' },
    } as never);
    const result = await executeAppStatus({ app_name: app.name }, {
      address, clientManager: {} as CosmosClientManager, appRegistry: registry,
      signing: store.getState().signing!, tiers: [],
    });
    expect(result.success).toBe(true);
    expect(appStatus).toHaveBeenCalledTimes(1);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({
      provisionState: 'confirmed', connectionStale: false, readinessStale: true,
    });
    vi.mocked(getLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'failed' });
    await render();
    expect(getLeaseStatus).toHaveBeenCalledTimes(1);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ provisionState: 'failed', readinessStale: false });
  });

  it.each([150, 300, 600].flatMap(failedAfter => [false, true].map(reload => ({ failedAfter, reload }))))('observes failure after $failedAfter seconds despite foreground connection refresh and reload=$reload', async ({ failedAfter, reload }) => {
    const app = addApp({ provisionState: 'confirmed', readinessStale: true, connectionStale: true,
      url: 'https://old.example.com', connection: { host: '', fqdn: 'old.example.com' } });
    vi.mocked(appStatus).mockResolvedValue({
      chainState: { state: LeaseState.LEASE_STATE_ACTIVE, items: [] },
      fredStatus: { state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'restarting' },
      connection: { host: '', fqdn: 'app.example.com' },
    } as never);
    await executeAppStatus({ app_name: app.name }, {
      address, clientManager: {} as CosmosClientManager, appRegistry: registry,
      signing: store.getState().signing!, tiers: [],
    });
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ connectionStale: false, readinessStale: true });
    const started = Date.now();
    vi.mocked(getLeaseStatus).mockImplementation(async () => ({
      state: LeaseState.LEASE_STATE_ACTIVE,
      provision_status: Date.now() - started >= failedAfter * 1000 ? 'failed' : 'restarting',
    }));
    await render();
    if (reload) {
      await advance(30_000);
      await act(async () => root.unmount());
      root = createRoot(container);
      // The fresh hook has no prior in-memory retry budget; persisted readiness
      // uncertainty must still grant the longer observation window.
      await render();
    }
    await advance(105_000 - (reload ? 30_000 : 0));
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ provisionState: 'confirmed', readinessStale: true });
    await advance(650_000);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({
      provisionState: 'failed', status: 'failed', readinessStale: false, connectionStale: false,
    });
    expect(vi.mocked(getLeaseStatus).mock.calls.length).toBeGreaterThan(APP_RECOVERY_MAX_ATTEMPTS);
    const readsAfterFailure = vi.mocked(getLeaseStatus).mock.calls.length;
    await advance(APP_CONNECTION_RECOVERY_INTERVAL_MS * APP_CONNECTION_RECOVERY_MAX_ATTEMPTS);
    expect(getLeaseStatus).toHaveBeenCalledTimes(readsAfterFailure);
  });

  it('bounds readiness rechecks at eight attempts after fresh connections remove inventory staleness', async () => {
    addApp({ provisionState: 'confirmed', readinessStale: true, connectionStale: false,
      url: 'https://app.example.com', connection: { host: '', fqdn: 'app.example.com' } });
    vi.mocked(getLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'updating' });
    await render();
    await advance(APP_CONNECTION_RECOVERY_INTERVAL_MS * APP_CONNECTION_RECOVERY_MAX_ATTEMPTS);
    expect(getLeaseStatus).toHaveBeenCalledTimes(APP_CONNECTION_RECOVERY_MAX_ATTEMPTS);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({
      provisionState: 'confirmed', readinessStale: true, connectionStale: false,
    });
    await advance(APP_CONNECTION_RECOVERY_INTERVAL_MS * APP_CONNECTION_RECOVERY_MAX_ATTEMPTS);
    expect(getLeaseStatus).toHaveBeenCalledTimes(APP_CONNECTION_RECOVERY_MAX_ATTEMPTS);
  });

  it('rechecks a previously failed app until a post-maintenance runtime verdict arrives', async () => {
    addApp({ provisionState: 'failed', readinessStale: true, connectionStale: true,
      url: 'https://old.example.com', connection: { host: '', fqdn: 'old.example.com' } });
    vi.mocked(getLeaseStatus).mockRejectedValueOnce(new Error('Provider status unavailable'));
    await render();
    expect(getLeaseStatus).toHaveBeenCalledTimes(1);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({
      provisionState: 'failed', readinessStale: true, connectionStale: false,
    });
    await advance(AUTO_REFRESH_INTERVAL_MS);
    expect(getLeaseStatus).toHaveBeenCalledTimes(2);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({
      provisionState: 'confirmed', readinessStale: false, status: 'running',
    });
  });

  it.each([0, 1, APP_RECOVERY_MAX_ATTEMPTS])('repairs invalidated DNS metadata after the initial budget, with readiness confirmed after %s rounds', async (readyAfter) => {
    addApp({ provisionState: readyAfter === 0 ? 'confirmed' : 'unconfirmed', url: 'https://new.example.com',
      connection: { host: '', fqdn: 'old.example.com' }, connectionStale: true });
    for (let attempt = 1; attempt < readyAfter; attempt++) {
      vi.mocked(getLeaseStatus).mockResolvedValueOnce({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'provisioning' });
    }
    const connectionRead = vi.mocked(getLeaseConnectionInfo).getMockImplementation()!;
    vi.mocked(getLeaseConnectionInfo).mockRejectedValue(new Error('Provider restarting'));
    await render();
    for (let attempt = 0; attempt < APP_RECOVERY_MAX_ATTEMPTS - 1; attempt++) {
      await advance(AUTO_REFRESH_INTERVAL_MS * 2 ** attempt);
    }
    expect(getLeaseConnectionInfo).toHaveBeenCalledTimes(APP_RECOVERY_MAX_ATTEMPTS);
    expect(getAuthToken).toHaveBeenCalledTimes(APP_RECOVERY_MAX_ATTEMPTS * 2);
    expect(getLeaseStatus).toHaveBeenCalledTimes(APP_RECOVERY_MAX_ATTEMPTS);
    expect(registry.getAppByLease(address, LEASE_UUID)?.connectionStale).toBe(true);
    vi.mocked(getLeaseConnectionInfo).mockImplementation(connectionRead);
    await advance(APP_CONNECTION_RECOVERY_INTERVAL_MS - APP_RECOVERY_POLL_INTERVAL_MS);
    expect(getLeaseConnectionInfo).toHaveBeenCalledTimes(APP_RECOVERY_MAX_ATTEMPTS);
    await advance(APP_RECOVERY_POLL_INTERVAL_MS);
    expect(getLeaseConnectionInfo).toHaveBeenCalledTimes(APP_RECOVERY_MAX_ATTEMPTS + 1);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ connectionStale: false, connection: { fqdn: 'app.example.com' } });
    await advance(APP_CONNECTION_RECOVERY_INTERVAL_MS);
    expect(getLeaseConnectionInfo).toHaveBeenCalledTimes(APP_RECOVERY_MAX_ATTEMPTS + 1);
  });

  it.each([
    { saved: false, stale: undefined },
    { saved: false, stale: true },
    { saved: true, stale: true },
  ])('bounds permanently unreachable providers with saved inventory=$saved, stale=$stale', async ({ saved, stale }) => {
    addApp({ provisionState: 'confirmed', connectionStale: stale,
      ...(saved ? { url: 'https://old.example.com', connection: { host: '', fqdn: 'old.example.com' } } : {}),
    });
    vi.mocked(getLeaseStatus).mockRejectedValue(new Error('Provider unavailable'));
    vi.mocked(getLeaseConnectionInfo).mockRejectedValue(new Error('Provider unavailable'));
    const maxAttempts = saved ? APP_CONNECTION_RECOVERY_MAX_ATTEMPTS : APP_RECOVERY_MAX_ATTEMPTS;
    await render();
    await advance(APP_CONNECTION_RECOVERY_INTERVAL_MS * APP_CONNECTION_RECOVERY_MAX_ATTEMPTS);
    expect(getLeaseStatus).toHaveBeenCalledTimes(maxAttempts);
    expect(getLeaseConnectionInfo).toHaveBeenCalledTimes(maxAttempts);
    expect(getAuthToken).toHaveBeenCalledTimes(maxAttempts * 2);
    await advance(APP_CONNECTION_RECOVERY_INTERVAL_MS * APP_CONNECTION_RECOVERY_MAX_ATTEMPTS);
    expect(getAuthToken).toHaveBeenCalledTimes(maxAttempts * 2);
    expect(registry.getAppByLease(address, LEASE_UUID)?.provisionState).toBe('confirmed');
  });

  it('caps newly confirmed stale-inventory recovery without resetting used attempts', async () => {
    addApp({ provisionState: 'unconfirmed', connectionStale: true,
      url: 'https://old.example.com', connection: { host: '', fqdn: 'old.example.com' },
    });
    vi.mocked(getLeaseConnectionInfo).mockRejectedValue(new Error('Connection unavailable'));
    await render();
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ provisionState: 'confirmed', connectionStale: true });
    await advance(APP_CONNECTION_RECOVERY_INTERVAL_MS * APP_CONNECTION_RECOVERY_MAX_ATTEMPTS);
    expect(getLeaseStatus).toHaveBeenCalledTimes(APP_CONNECTION_RECOVERY_MAX_ATTEMPTS);
    expect(getLeaseConnectionInfo).toHaveBeenCalledTimes(APP_CONNECTION_RECOVERY_MAX_ATTEMPTS);
    expect(getAuthToken).toHaveBeenCalledTimes(APP_CONNECTION_RECOVERY_MAX_ATTEMPTS * 2);
    await advance(APP_CONNECTION_RECOVERY_INTERVAL_MS);
    expect(getAuthToken).toHaveBeenCalledTimes(APP_CONNECTION_RECOVERY_MAX_ATTEMPTS * 2);
  });

  it.each(['unshapeable connection', 'retained status'])('keeps the original retry allowance and cadence after a partial %s observation', async (partial) => {
    addApp({ provisionState: 'confirmed', connectionStale: true, connection: { host: '' } });
    vi.mocked(getLeaseConnectionInfo).mockRejectedValue(new Error('Connection unavailable'));
    await render();
    for (let attempt = 0; attempt < APP_RECOVERY_MAX_ATTEMPTS - 1; attempt++) {
      await advance(AUTO_REFRESH_INTERVAL_MS * 2 ** attempt);
    }
    if (partial === 'unshapeable connection') {
      vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
        lease_uuid: LEASE_UUID, tenant: address, provider_uuid: PROVIDER_UUID, connection: { host: '' },
      });
    } else {
      vi.mocked(getLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'retained' });
    }
    for (let attempt = APP_RECOVERY_MAX_ATTEMPTS; attempt < APP_CONNECTION_RECOVERY_MAX_ATTEMPTS; attempt++) {
      await advance(APP_CONNECTION_RECOVERY_INTERVAL_MS - APP_RECOVERY_POLL_INTERVAL_MS);
      expect(getLeaseConnectionInfo).toHaveBeenCalledTimes(attempt);
      await advance(APP_RECOVERY_POLL_INTERVAL_MS);
      expect(getLeaseConnectionInfo).toHaveBeenCalledTimes(attempt + 1);
    }
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({
      provisionState: partial === 'retained status' ? 'unconfirmed' : 'confirmed',
      connectionStale: partial === 'retained status',
    });
    await advance(APP_CONNECTION_RECOVERY_INTERVAL_MS * APP_CONNECTION_RECOVERY_MAX_ATTEMPTS);
    expect(getLeaseConnectionInfo).toHaveBeenCalledTimes(APP_CONNECTION_RECOVERY_MAX_ATTEMPTS);
    expect(getAuthToken).toHaveBeenCalledTimes(APP_CONNECTION_RECOVERY_MAX_ATTEMPTS * 2);
  });

  it.each([
    { state: LeaseState.LEASE_STATE_CLOSED },
    { state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'failed' },
  ])('retires stale connection recovery when the provider later reports failure: %j', async status => {
    addApp({ provisionState: 'confirmed', connectionStale: true,
      url: 'https://old.example.com', connection: { host: '', fqdn: 'old.example.com' },
    });
    vi.mocked(getLeaseConnectionInfo).mockRejectedValue(new Error('Connection unavailable'));
    await render();
    for (let attempt = 0; attempt < APP_RECOVERY_MAX_ATTEMPTS - 1; attempt++) {
      await advance(AUTO_REFRESH_INTERVAL_MS * 2 ** attempt);
    }
    vi.mocked(getLeaseStatus).mockResolvedValue(status);
    await advance(APP_CONNECTION_RECOVERY_INTERVAL_MS);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ provisionState: 'failed', status: 'failed' });
    expect(getLeaseStatus).toHaveBeenCalledTimes(APP_RECOVERY_MAX_ATTEMPTS + 1);
    await advance(APP_CONNECTION_RECOVERY_INTERVAL_MS * APP_CONNECTION_RECOVERY_MAX_ATTEMPTS);
    expect(getLeaseStatus).toHaveBeenCalledTimes(APP_RECOVERY_MAX_ATTEMPTS + 1);
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

  it('shares recovery turns across repeated foreground interruptions without consuming retry budgets', async () => {
    const leaseUuids = [LEASE_UUID, '550e8400-e29b-41d4-a716-446655440002', '550e8400-e29b-41d4-a716-446655440003'];
    leaseUuids.forEach((leaseUuid, index) => addApp({
      leaseUuid, name: `app-${index}`, providerUrl: `https://provider-${index}.example.com`,
    }));
    vi.mocked(getLeaseStatus).mockReturnValue(new Promise(() => {}));
    vi.mocked(getLeaseConnectionInfo).mockReturnValue(new Promise(() => {}));
    await render();

    // Cancel every app more often than its failure budget permits. Each one
    // must still get a turn and remain eligible when the providers recover.
    const interruptions = leaseUuids.length * (APP_RECOVERY_MAX_ATTEMPTS + 1);
    for (let turn = 0; turn < interruptions; turn++) {
      expect(getLeaseStatus).toHaveBeenCalledTimes(turn + 1);
      expect(vi.mocked(getLeaseStatus).mock.calls[turn][1]).toBe(leaseUuids[turn % leaseUuids.length]);
      await act(async () => { store.setState({ isStreaming: true }); });
      await advance(APP_RECOVERY_POLL_INTERVAL_MS);
      expect(vi.mocked(getLeaseStatus).mock.calls[turn][4]?.aborted).toBe(true);
      expect(getAuthToken).toHaveBeenCalledTimes((turn + 1) * 2);

      if (turn === interruptions - 1) {
        vi.mocked(getLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'ready' });
        vi.mocked(getLeaseConnectionInfo).mockImplementation(async (_url, leaseUuid) => ({
          lease_uuid: leaseUuid, tenant: address, provider_uuid: PROVIDER_UUID,
          connection: { host: '', fqdn: 'recovered.example.com' },
        }));
      }
      await act(async () => { store.setState({ isStreaming: false }); });
      await advance(APP_RECOVERY_POLL_INTERVAL_MS);
    }

    await advance(APP_RECOVERY_POLL_INTERVAL_MS * (leaseUuids.length - 1));
    expect(registry.getApps(address).every(app => app.status === 'running')).toBe(true);
    expect(getLeaseStatus).toHaveBeenCalledTimes(interruptions + leaseUuids.length);
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
