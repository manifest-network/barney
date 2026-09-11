import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { getLeaseConnectionInfo, getLeaseStatus, type ConnectionDetails } from '@manifest-network/manifest-sdk/deploy';
import { discoverTenantApps, hasPendingRecoveryAuthentication, hydrateDiscoveredApp } from './appDiscovery';
import { getProviders, getSKUs, type Provider, type SKU } from './sku';
import { LeaseState, type Lease } from './billing';
import * as registry from '../registry/appRegistry';
import type { AppEntry } from '../registry/appRegistry';
import { AI_TOOL_API_TIMEOUT_MS, APP_RECOVERY_TIMEOUT_MS } from '../config/constants';

vi.mock('./sku', () => ({ getProviders: vi.fn(), getSKUs: vi.fn() }));
vi.mock('../utils/errors', () => ({ logError: vi.fn() }));
vi.mock('@manifest-network/manifest-sdk/deploy', async original => ({
  ...await original<typeof import('@manifest-network/manifest-sdk/deploy')>(),
  getLeaseStatus: vi.fn(),
  getLeaseConnectionInfo: vi.fn(),
}));

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const PROVIDER_UUID = '550e8400-e29b-41d4-a716-446655440001';
const PROVIDER_URL = 'https://provider.example.com';
let address: string;
let sequence = 0;
const signing = { authTokens: { getAuthToken: vi.fn(), getLeaseDataAuthToken: vi.fn() } };

function lease(overrides: Partial<Lease> = {}): Lease {
  return {
    uuid: LEASE_UUID,
    tenant: address,
    providerUuid: PROVIDER_UUID,
    state: LeaseState.LEASE_STATE_ACTIVE,
    createdAt: new Date('2026-01-01T12:00:00Z'),
    items: [{ skuUuid: 'sku-1', serviceName: 'web', customDomain: 'web.example.com' }],
    ...overrides,
  } as Lease;
}

function app(overrides: Partial<AppEntry> = {}): AppEntry {
  return registry.addApp(address, {
    name: 'existing-app', leaseUuid: LEASE_UUID, providerUuid: PROVIDER_UUID,
    providerUrl: PROVIDER_URL, createdAt: 1, size: 'docker-small',
    status: 'deploying', chainState: 'active', provisionState: 'unconfirmed',
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function connectionResult(connection: ConnectionDetails) {
  return { lease_uuid: LEASE_UUID, tenant: address, provider_uuid: PROVIDER_UUID, connection };
}

beforeEach(() => {
  vi.resetAllMocks();
  address = `manifest1discovery${++sequence}`;
  vi.mocked(getProviders).mockResolvedValue([
    { uuid: PROVIDER_UUID, apiUrl: PROVIDER_URL, active: false } as Provider,
  ]);
  vi.mocked(getSKUs).mockResolvedValue([
    { uuid: 'sku-1', providerUuid: PROVIDER_UUID, name: 'docker-small', active: false } as SKU,
  ]);
  signing.authTokens.getAuthToken.mockResolvedValue('provider-token');
  vi.mocked(getLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'ready' });
  vi.mocked(getLeaseConnectionInfo).mockResolvedValue(connectionResult({ host: 'host.example.com', fqdn: 'app.example.com' }));
});

afterEach(() => vi.useRealTimers());

describe('discoverTenantApps', () => {
  it('rebuilds inventory from owned live leases and inactive catalog records without inventing a manifest', async () => {
    const result = await discoverTenantApps(address, [
      lease(), lease({ uuid: 'wrong-wallet', tenant: 'another-wallet' }),
      lease({ uuid: 'closed', state: LeaseState.LEASE_STATE_CLOSED }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      leaseUuid: LEASE_UUID, providerUuid: PROVIDER_UUID, providerUrl: PROVIDER_URL,
      size: 'docker-small', createdAt: new Date('2026-01-01T12:00:00Z').getTime(),
      chainState: 'active', provisionState: 'unconfirmed', status: 'deploying',
      customDomains: [{ serviceName: 'web', customDomain: 'web.example.com' }],
    });
    expect(result[0].manifest).toBeUndefined();
    expect(result[0].name).not.toBe('web');
    expect(getProviders).toHaveBeenCalledWith(false);
    expect(getSKUs).toHaveBeenCalledWith(false);
    await hydrateDiscoveredApp(address, result[0], signing);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({
      status: 'running', provisionState: 'confirmed', url: 'https://app.example.com',
    });
  });

  it('retains discovered apps through catalog failures and fills missing metadata on a later pass', async () => {
    vi.mocked(getProviders).mockRejectedValueOnce(new Error('offline'));
    vi.mocked(getSKUs).mockRejectedValueOnce(new Error('offline'));
    const [discovered] = await discoverTenantApps(address, [lease()]);
    expect(discovered).toMatchObject({ providerUrl: '', size: 'unknown', leaseUuid: LEASE_UUID });
    expect(await discoverTenantApps(address, [lease()])).toEqual([]);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ providerUrl: PROVIDER_URL, size: 'docker-small' });
  });

  it('does not query catalogs or overwrite local names/manifests for complete known apps', async () => {
    const previous = app({ name: 'my-app', manifest: '{"image":"nginx"}' });
    expect(await discoverTenantApps(address, [lease()])).toEqual([]);
    expect(getProviders).not.toHaveBeenCalled();
    expect(getSKUs).not.toHaveBeenCalled();
    expect(registry.getAppByLease(address, LEASE_UUID)).toEqual(previous);
  });

  it('leaves a mixed lease size unknown until every item can be resolved', async () => {
    const mixed = lease({ items: [...lease().items, { skuUuid: 'sku-missing' } as Lease['items'][number]] });
    await discoverTenantApps(address, [mixed]);
    expect(registry.getAppByLease(address, LEASE_UUID)?.size).toBe('unknown');
  });

  it('does not apply missing metadata over a concurrent registry update', async () => {
    app({ providerUrl: '', size: 'unknown' });
    const pending = deferred<Provider[]>();
    vi.mocked(getProviders).mockReturnValueOnce(pending.promise);
    const work = discoverTenantApps(address, [lease()]);
    registry.updateApp(address, LEASE_UUID, { chainState: 'absent' });
    pending.resolve([{ uuid: PROVIDER_UUID, apiUrl: PROVIDER_URL } as Provider]);
    await work;
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ chainState: 'absent', providerUrl: '', size: 'unknown' });
  });

  it('abandons imports immediately after cancellation, even when the catalog resolves later', async () => {
    const pending = deferred<Provider[]>();
    vi.mocked(getProviders).mockReturnValueOnce(pending.promise);
    const abort = new AbortController();
    const work = discoverTenantApps(address, [lease()], { signal: abort.signal });
    abort.abort();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve([{ uuid: PROVIDER_UUID, apiUrl: PROVIDER_URL } as Provider]);
    expect(registry.getApps(address)).toEqual([]);
  });

  it('imports chain inventory when a catalog read exceeds its deadline', async () => {
    vi.useFakeTimers();
    vi.mocked(getProviders).mockReturnValueOnce(new Promise(() => {}));
    const work = discoverTenantApps(address, [lease()]);
    await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS);
    expect(await work).toHaveLength(1);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ providerUrl: '', size: 'docker-small' });
  });
});

describe('hydrateDiscoveredApp', () => {
  it('preserves saved service inventory when only a status endpoint refreshes', async () => {
    const previous = app({
      url: 'https://web.provider.example',
      connection: {
        host: '203.0.113.10',
        services: {
          web: { fqdn: 'web.provider.example', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } } },
          db: { fqdn: 'db.provider.example', ports: { '5432/tcp': { host_ip: '0.0.0.0', host_port: 32001 } } },
        },
      },
    });
    vi.mocked(getLeaseConnectionInfo).mockRejectedValueOnce(new Error('connection unavailable'));
    vi.mocked(getLeaseStatus).mockResolvedValueOnce({
      state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'ready',
      endpoints: { '80/tcp': 'http://203.0.113.10:32002' },
    });
    await hydrateDiscoveredApp(address, previous, signing);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({
      status: 'running', url: '203.0.113.10:32002', connection: previous.connection,
    });
  });

  it('recovers readiness and provider-reported access details with read-only wallet authentication', async () => {
    signing.authTokens.getAuthToken.mockResolvedValueOnce('status-token').mockResolvedValueOnce('connection-token');
    await hydrateDiscoveredApp(address, app(), signing);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({
      status: 'running', provisionState: 'confirmed', url: 'https://app.example.com',
      connection: { host: 'host.example.com', fqdn: 'app.example.com' },
    });
    expect(signing.authTokens.getAuthToken).toHaveBeenCalledWith(LEASE_UUID);
    expect(signing.authTokens.getAuthToken).toHaveBeenCalledTimes(2);
    expect(getLeaseStatus).toHaveBeenCalledWith(PROVIDER_URL, LEASE_UUID, 'status-token', expect.any(Function), expect.any(AbortSignal), true);
    expect(getLeaseConnectionInfo).toHaveBeenCalledWith(PROVIDER_URL, LEASE_UUID, 'connection-token', expect.any(Function), true);
  });

  it('preserves a confirmation during provider progress, but records a failure verdict', async () => {
    const previous = app({ provisionState: 'confirmed' });
    vi.mocked(getLeaseStatus).mockResolvedValueOnce({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'restarting' });
    await hydrateDiscoveredApp(address, previous, signing);
    expect(registry.getAppByLease(address, LEASE_UUID)?.provisionState).toBe('confirmed');
    vi.mocked(getLeaseStatus).mockResolvedValueOnce({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'failing' });
    await hydrateDiscoveredApp(address, registry.getApps(address)[0], signing);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ provisionState: 'failed', status: 'failed' });
  });

  it.each([
    { verdict: 'ready', provisionState: 'confirmed', status: 'running', complete: false },
    { verdict: 'failing', provisionState: 'failed', status: 'failed', complete: true },
  ])('preserves $verdict when connection authentication rejects', async ({ verdict, provisionState, status, complete }) => {
    signing.authTokens.getAuthToken.mockResolvedValueOnce('status-token').mockRejectedValueOnce(new Error('signing rejected'));
    vi.mocked(getLeaseStatus).mockResolvedValueOnce({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: verdict });

    expect(await hydrateDiscoveredApp(address, app(), signing)).toMatchObject({ complete });
    expect(getLeaseStatus).toHaveBeenCalledWith(PROVIDER_URL, LEASE_UUID, 'status-token', expect.any(Function), expect.any(AbortSignal), true);
    expect(getLeaseConnectionInfo).not.toHaveBeenCalled();
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ provisionState, status });
    expect(hasPendingRecoveryAuthentication(signing.authTokens)).toBe(false);
  });

  it.each([
    { verdict: 'ready', provisionState: 'confirmed', status: 'running', complete: false },
    { verdict: 'failing', provisionState: 'failed', status: 'failed', complete: true },
  ])('preserves $verdict at the deadline while connection authentication is still pending', async ({ verdict, provisionState, status, complete }) => {
    vi.useFakeTimers();
    const connectionToken = deferred<string>();
    signing.authTokens.getAuthToken.mockResolvedValueOnce('status-token').mockReturnValueOnce(connectionToken.promise);
    vi.mocked(getLeaseStatus).mockResolvedValueOnce({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: verdict });
    const work = hydrateDiscoveredApp(address, app(), signing);

    await vi.advanceTimersByTimeAsync(0);
    expect(getLeaseStatus).toHaveBeenCalledOnce();
    expect(getLeaseConnectionInfo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(APP_RECOVERY_TIMEOUT_MS);
    expect(await work).toMatchObject({ complete });
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ provisionState, status });
    expect(hasPendingRecoveryAuthentication(signing.authTokens)).toBe(true);

    connectionToken.resolve('late-connection-token');
    await vi.advanceTimersByTimeAsync(0);
    expect(getLeaseConnectionInfo).not.toHaveBeenCalled();
    expect(hasPendingRecoveryAuthentication(signing.authTokens)).toBe(false);
  });

  it('discards completed status on cancellation while connection authentication is pending', async () => {
    vi.useFakeTimers();
    const connectionToken = deferred<string>();
    signing.authTokens.getAuthToken.mockResolvedValueOnce('status-token').mockReturnValueOnce(connectionToken.promise);
    const previous = app();
    const abort = new AbortController();
    const work = hydrateDiscoveredApp(address, previous, signing, { signal: abort.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(getLeaseStatus).toHaveBeenCalledOnce();

    const cancelled = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    await cancelled;
    connectionToken.resolve('late-connection-token');
    await vi.advanceTimersByTimeAsync(0);
    expect(getLeaseConnectionInfo).not.toHaveBeenCalled();
    expect(registry.getAppByLease(address, LEASE_UUID)).toEqual(previous);
    expect(hasPendingRecoveryAuthentication(signing.authTokens)).toBe(false);
  });

  it('does not change a workload verdict or access details when both reads fail', async () => {
    const previous = app({ provisionState: 'confirmed', url: 'https://saved.example.com' });
    vi.mocked(getLeaseStatus).mockRejectedValueOnce(new Error('offline'));
    vi.mocked(getLeaseConnectionInfo).mockRejectedValueOnce(new Error('offline'));
    await hydrateDiscoveredApp(address, previous, signing);
    expect(registry.getAppByLease(address, LEASE_UUID)).toEqual(previous);
  });

  it('keeps a completed status observation when the connection endpoint never resolves', async () => {
    vi.useFakeTimers();
    vi.mocked(getLeaseConnectionInfo).mockReturnValueOnce(new Promise(() => {}));
    const work = hydrateDiscoveredApp(address, app(), signing);
    await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS);
    await work;
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ status: 'running', provisionState: 'confirmed' });
    expect(registry.getAppByLease(address, LEASE_UUID)?.connection).toBeUndefined();
  });

  it('keeps valid connection details when the status endpoint never resolves', async () => {
    vi.useFakeTimers();
    vi.mocked(getLeaseStatus).mockReturnValueOnce(new Promise(() => {}));
    const work = hydrateDiscoveredApp(address, app(), signing);
    await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS);
    await work;
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({
      status: 'deploying', provisionState: 'unconfirmed', url: 'https://app.example.com',
    });
  });

  it('rejects connection metadata belonging to another lease while preserving the independent status observation', async () => {
    vi.mocked(getLeaseConnectionInfo).mockResolvedValueOnce({
      ...connectionResult({ host: 'wrong.example.com' }), lease_uuid: 'another-lease',
    });
    await hydrateDiscoveredApp(address, app(), signing);
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ provisionState: 'confirmed' });
    expect(registry.getAppByLease(address, LEASE_UUID)?.url).toBeUndefined();
  });

  it('drops late provider observations after a concurrent stop', async () => {
    const previous = app();
    const pending = deferred<Awaited<ReturnType<typeof getLeaseStatus>>>();
    vi.mocked(getLeaseStatus).mockReturnValueOnce(pending.promise);
    const work = hydrateDiscoveredApp(address, previous, signing);
    await vi.waitFor(() => expect(getLeaseStatus).toHaveBeenCalled());
    registry.updateApp(address, LEASE_UUID, { chainState: 'absent' });
    pending.resolve({ state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'ready' });
    await work;
    expect(registry.getAppByLease(address, LEASE_UUID)).toMatchObject({ chainState: 'absent', provisionState: 'unconfirmed', status: 'stopped' });
    expect(registry.getAppByLease(address, LEASE_UUID)?.url).toBeUndefined();
  });

  it('bounds signing/provider work and cancels without letting late signatures start requests', async () => {
    const pending = deferred<string>();
    signing.authTokens.getAuthToken.mockReturnValue(pending.promise);
    const apps = Array.from({ length: 3 }, (_, index) => app({
      name: `app-${index}`, leaseUuid: `550e8400-e29b-41d4-a716-44665544000${index}`,
    }));
    const abort = new AbortController();
    const work = hydrateDiscoveredApp(address, apps[0], signing, { signal: abort.signal });
    expect(signing.authTokens.getAuthToken).toHaveBeenCalledTimes(1);
    abort.abort();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve('late-token');
    await Promise.resolve();
    expect(getLeaseStatus).not.toHaveBeenCalled();
    expect(getLeaseConnectionInfo).not.toHaveBeenCalled();
  });

  it('times out a stalled signer and allows the next polling pass to retry', async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    signing.authTokens.getAuthToken.mockReturnValueOnce(pending.promise);
    const previous = app();
    const work = hydrateDiscoveredApp(address, previous, signing);
    await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS);
    await work;
    expect(registry.getAppByLease(address, LEASE_UUID)).toEqual(previous);
    pending.resolve('too-late');
    await Promise.resolve();
    expect(getLeaseStatus).not.toHaveBeenCalled();
    await hydrateDiscoveredApp(address, registry.getApps(address)[0], signing);
    expect(registry.getAppByLease(address, LEASE_UUID)?.status).toBe('running');
  });

  it('bounds the entire round across signatures and provider waits while retaining completed evidence', async () => {
    vi.useFakeTimers();
    signing.authTokens.getAuthToken.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve('token'), APP_RECOVERY_TIMEOUT_MS / 3);
    }));
    vi.mocked(getLeaseConnectionInfo).mockReturnValueOnce(new Promise(() => {}));
    const first = app();
    const second = app({ name: 'second', leaseUuid: '550e8400-e29b-41d4-a716-446655440002' });
    const work = hydrateDiscoveredApp(address, first, signing);
    await vi.advanceTimersByTimeAsync(APP_RECOVERY_TIMEOUT_MS);
    const observation = await work;
    expect(signing.authTokens.getAuthToken).toHaveBeenCalledTimes(2);
    expect(getLeaseStatus).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({ app: { leaseUuid: first.leaseUuid, provisionState: 'confirmed' }, complete: false });
    expect(registry.getAppByLease(address, second.leaseUuid)?.provisionState).toBe('unconfirmed');
  });

  it('distinguishes explicit empty port inventories from missing nested endpoint metadata', async () => {
    const first = app();
    vi.mocked(getLeaseConnectionInfo).mockResolvedValueOnce(connectionResult({
      host: '', ports: {}, services: { worker: { ports: {} } },
    }));
    expect(await hydrateDiscoveredApp(address, first, signing)).toMatchObject({ complete: true });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValueOnce(connectionResult({
      host: '', ports: {}, services: { worker: {} },
    }));
    expect(await hydrateDiscoveredApp(address, registry.getApps(address)[0], signing)).toMatchObject({ complete: false });
  });

});
