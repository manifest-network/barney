import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FredLeaseRelease, FredLeaseReleases } from '@manifest-network/manifest-sdk/deploy';
import type { AppEntry } from '../../registry/appRegistry';
import type { ToolExecutorOptions } from './types';
import { makeRegistry } from './testHelpers';

vi.mock('../../api/fred', () => ({
  getLeaseProvision: vi.fn(),
  getLeaseReleases: vi.fn(),
  getLeaseLogs: vi.fn(),
}));
vi.mock('../../api/billing', async (importOriginal) => ({
  ...(await importOriginal()),
  getLease: vi.fn(),
  getLeasesByTenant: vi.fn(),
}));
vi.mock('../../api/appDiscovery', () => ({ discoverTenantApps: vi.fn().mockResolvedValue([]) }));
vi.mock('../../utils/errors', () => ({ logError: vi.fn() }));

const address = 'manifest1alice';
const app: AppEntry = {
  name: 'my-app', leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
  providerUrl: 'https://provider.example', providerUuid: 'provider-1',
  size: 'small', createdAt: 1, status: 'running', chainState: 'active', provisionState: 'confirmed',
  manifest: '{"image":"nginx:old"}',
};
const scope = { address, providerUrl: app.providerUrl, leaseUuid: app.leaseUuid };
const payload = '{"image":"nginx:new","env":{"PASSWORD":"private-secret"}}';
const release = (version: number, status = 'active', extra: Partial<FredLeaseRelease> = {}): FredLeaseRelease => ({
  version, status, image: 'nginx', created_at: '2026-09-22T12:00:00Z', ...extra,
});
const history = (...releases: FredLeaseRelease[]): FredLeaseReleases => ({
  lease_uuid: app.leaseUuid, tenant: address, provider_uuid: app.providerUuid, releases,
});
let operations: typeof import('./maintenanceOperation');
let reconcile: typeof import('./maintenanceReconciliation')['reconcilePendingMaintenance'];
let fred: typeof import('../../api/fred');
let billing: typeof import('../../api/billing');
let options: ToolExecutorOptions;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  operations = await import('./maintenanceOperation');
  reconcile = (await import('./maintenanceReconciliation')).reconcilePendingMaintenance;
  fred = await import('../../api/fred');
  billing = await import('../../api/billing');
  vi.mocked(fred.getLeaseProvision).mockResolvedValue({ status: 'ready', fail_count: 0 });
  vi.mocked(fred.getLeaseReleases).mockResolvedValue(history(release(1, 'superseded'), release(2)));
  vi.mocked(billing.getLease).mockResolvedValue({ uuid: app.leaseUuid, state: 2, items: [] } as never);
  options = {
    address, appRegistry: makeRegistry([{ ...app }]), clientManager: null, tiers: [],
    signing: { authTokens: { getAuthToken: vi.fn().mockResolvedValue('fresh-auth') } } as unknown as ToolExecutorOptions['signing'],
  };
});

async function prepare(operation: 'restart' | 'update' = 'update', accepted = true) {
  const command = await operations.getOrCreateMaintenanceOperation({
    ...scope, operation, baselineReleaseVersions: [1],
    ...(operation === 'update' && { manifest: payload, previousManifest: app.manifest }),
  });
  await operations.markMaintenanceOperationDispatched(command);
  if (accepted) await operations.markMaintenanceOperationAccepted(command);
  return command;
}

async function reload() {
  vi.resetModules();
  operations = await import('./maintenanceOperation');
  reconcile = (await import('./maintenanceReconciliation')).reconcilePendingMaintenance;
}

const pending = () => operations.getPendingMaintenanceOperation(address, app.providerUrl, app.leaseUuid);

describe('read-only maintenance reconciliation', () => {
  it.each([false, true])('does not overwrite a successor command while reconciling an old read (successor settled: %s)', async (settleSuccessor) => {
    const first = await prepare();
    let releaseRead!: (value: FredLeaseReleases) => void;
    vi.mocked(fred.getLeaseReleases).mockImplementationOnce(() => new Promise((resolve) => { releaseRead = resolve; }));
    const observation = reconcile(app, options);
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    await operations.completeMaintenanceOperation(first);
    const successor = await operations.getOrCreateMaintenanceOperation({
      ...scope, operation: 'update', manifest: '{"image":"successor"}', baselineReleaseVersions: [1, 2],
    });
    options.appRegistry!.updateApp(address, app.leaseUuid, { manifest: '{"image":"successor"}', provisionState: 'failed' });
    if (settleSuccessor) await operations.completeMaintenanceOperation(successor);
    vi.mocked(options.appRegistry!.updateApp).mockClear();
    releaseRead(history(release(1, 'superseded'), release(2)));
    expect(await observation).toMatchObject({ outcome: 'unconfirmed' });
    expect(options.appRegistry!.updateApp).not.toHaveBeenCalled();
    expect(options.appRegistry!.getAppByLease(address, app.leaseUuid)).toMatchObject({ manifest: '{"image":"successor"}', provisionState: 'failed' });
    if (settleSuccessor) expect(pending()).toBeUndefined();
    else expect(pending()?.idempotencyKey).toBe(successor.idempotencyKey);
  });

  it('does not overwrite a changed registry snapshot even when the saved command is unchanged', async () => {
    const first = await prepare();
    let releaseRead!: (value: FredLeaseReleases) => void;
    vi.mocked(fred.getLeaseReleases).mockImplementationOnce(() => new Promise((resolve) => { releaseRead = resolve; }));
    const observation = reconcile(app, options);
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    options.appRegistry!.updateApp(address, app.leaseUuid, { chainState: 'absent', provisionState: 'failed' });
    vi.mocked(options.appRegistry!.updateApp).mockClear();
    releaseRead(history(release(1, 'superseded'), release(2)));
    expect(await observation).toMatchObject({ outcome: 'unconfirmed' });
    expect(options.appRegistry!.updateApp).not.toHaveBeenCalled();
    expect(pending()?.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('does not sign or query for an already-cancelled reconciliation', async () => {
    await prepare();
    const controller = new AbortController();
    controller.abort();
    await expect(reconcile(app, { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(options.signing!.authTokens.getAuthToken).not.toHaveBeenCalled();
    expect(fred.getLeaseProvision).not.toHaveBeenCalled();
    expect(fred.getLeaseReleases).not.toHaveBeenCalled();
    expect(pending()).toBeDefined();
  });

  it('does not query or settle when cancelled while authentication is minted', async () => {
    await prepare();
    const controller = new AbortController();
    vi.mocked(options.signing!.authTokens.getAuthToken).mockImplementation(async () => {
      controller.abort();
      return 'fresh-auth';
    });
    await expect(reconcile(app, { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(options.signing!.authTokens.getAuthToken).toHaveBeenCalledTimes(1);
    expect(fred.getLeaseProvision).not.toHaveBeenCalled();
    expect(fred.getLeaseReleases).not.toHaveBeenCalled();
    expect(pending()).toBeDefined();
  });

  it.each(['restart', 'update'] as const)('clears an acknowledged %s after reload without resubmitting', async (operation) => {
    const command = await prepare(operation);
    await reload();
    expect(pending()?.manifest).toBeUndefined();
    const verdict = await reconcile(app, options);
    expect(verdict).toMatchObject({ operation, outcome: 'succeeded', runtimeReady: true });
    expect(pending()).toBeUndefined();
    const { getCompletedMaintenance } = await import('./maintenanceCompletion');
    const completed = getCompletedMaintenance(command);
    expect(completed).toMatchObject({ payloadHash: command.payloadHash, result: { outcome: 'succeeded', result: { success: true } } });
    expect(JSON.stringify(completed)).not.toContain('private-secret');
    expect(JSON.stringify(completed)).not.toContain('nginx:new');
    expect(fred.getLeaseReleases).toHaveBeenCalledTimes(1);
    if (operation === 'update') expect(options.appRegistry!.getAppByLease(address, app.leaseUuid)?.manifest).toBeUndefined();
  });

  it('recovers and sanitizes the identified active release manifest', async () => {
    await prepare();
    await reload();
    const verdict = await reconcile(app, options, history(release(1, 'superseded'), release(2, 'active', { manifest: btoa(payload) })));
    expect(verdict?.outcome).toBe('succeeded');
    const saved = options.appRegistry!.getAppByLease(address, app.leaseUuid)?.manifest;
    expect(saved).toContain('nginx:new');
    expect(saved).not.toContain('private-secret');
    expect(fred.getLeaseReleases).not.toHaveBeenCalled();
  });

  it('does not cache a malformed or different historical manifest as the update payload', async () => {
    await prepare();
    await reload();
    await reconcile(app, options, history(release(1, 'superseded'), release(2, 'active', { manifest: btoa('{"image":"other:release"}') })));
    expect(options.appRegistry!.getAppByLease(address, app.leaseUuid)?.manifest).toBeUndefined();
  });

  it('keeps the pre-update manifest for a compensated failure after reload', async () => {
    await prepare();
    await reload();
    vi.mocked(fred.getLeaseProvision).mockResolvedValue({ status: 'ready', fail_count: 1, reason: 'UpdateFailed', message: 'Previous runtime restored.' });
    const verdict = await reconcile(app, options, history(release(1), release(2, 'failed', { reason: 'UpdateFailed' })));
    expect(verdict).toMatchObject({ outcome: 'failed', runtimeReady: true });
    expect(pending()).toBeUndefined();
    expect(options.appRegistry!.getAppByLease(address, app.leaseUuid)).toMatchObject({ status: 'running', manifest: app.manifest });
  });

  it('does not attribute a release to a command whose POST response was lost', async () => {
    const command = await prepare('update', false);
    await reload();
    expect(await reconcile(app, options)).toMatchObject({ outcome: 'unconfirmed', runtimeReady: true });
    expect(pending()?.idempotencyKey).toBe(command.idempotencyKey);
    expect(options.appRegistry!.getAppByLease(address, app.leaseUuid)?.manifest).toBe(app.manifest);
  });

  it('retains pending or ambiguous outcomes without losing the original baseline', async () => {
    const command = await prepare();
    for (const releases of [history(release(1)), history(release(1), release(2, 'deploying')), history(release(2, 'failed'), release(3))]) {
      expect(await reconcile(app, options, releases)).toMatchObject({ outcome: 'unconfirmed' });
      expect(pending()).toMatchObject({ idempotencyKey: command.idempotencyKey, baselineReleaseVersions: [1] });
    }
  });

  it.each(['app_status', 'app_releases'])('%s reconciles a reloaded update through its read path', async (tool) => {
    await prepare();
    await reload();
    vi.mocked(fred.getLeaseReleases).mockResolvedValue(history(release(1, 'superseded'), release(2, 'active', { manifest: btoa(payload) })));
    const queries = await import('./compositeQueries');
    const result = await (tool === 'app_status' ? queries.executeAppStatus : queries.executeAppReleases)({ app_name: app.name }, options);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ maintenance: { outcome: 'succeeded' } });
    expect(pending()).toBeUndefined();
    if (tool === 'app_status') expect(result.data).toMatchObject({ image: 'nginx:new' });
    expect(JSON.stringify(result.data)).not.toContain(btoa(payload));
    expect(JSON.stringify(result.data)).not.toContain('private-secret');
  });

  it('retires retained metadata after app_status observes a terminal chain lease', async () => {
    await prepare();
    vi.mocked(billing.getLease).mockResolvedValue({ uuid: app.leaseUuid, state: 3, items: [] } as never);
    const { executeAppStatus } = await import('./compositeQueries');
    expect((await executeAppStatus({ app_name: app.name }, options)).success).toBe(true);
    expect(pending()).toBeUndefined();
    expect(fred.getLeaseReleases).not.toHaveBeenCalled();
  });

  it('retires absent metadata only after both live-chain inventories succeed', async () => {
    await prepare();
    vi.mocked(billing.getLeasesByTenant).mockRejectedValueOnce(new Error('chain unavailable'));
    const { executeListApps } = await import('./compositeQueries');
    await executeListApps({ state: 'all' }, options);
    expect(pending()).toBeDefined();
    vi.mocked(billing.getLeasesByTenant).mockResolvedValue([]);
    await executeListApps({ state: 'all' }, options);
    expect(pending()).toBeUndefined();
  });
});
