import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FredLeaseRelease, FredLeaseReleases } from '@manifest-network/manifest-sdk/deploy';
import { sanitizeManifestForStorage, type AppEntry } from '../../registry/appRegistry';
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
  sessionStorage.clear();
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
  it.each(['confirmed', 'failed', undefined].flatMap(previous => [undefined, 'restarting', 'updating', 'unknown', ''].map(status => ({ previous, status }))))('reconciles prior $previous readiness when failed command settlement sees runtime status $status', async ({ previous, status }) => {
    await prepare();
    options.appRegistry!.updateApp(address, app.leaseUuid, { provisionState: previous as AppEntry['provisionState'] });
    if (status === undefined) vi.mocked(fred.getLeaseProvision).mockRejectedValueOnce(new Error('Provision unavailable'));
    else vi.mocked(fred.getLeaseProvision).mockResolvedValueOnce({ status, fail_count: 0 });
    expect(await reconcile(app, options, history(release(1), release(2, 'failed')))).toMatchObject({ outcome: 'failed' });
    const updated = options.appRegistry!.getAppByLease(address, app.leaseUuid)!;
    // Explicit progress records unconfirmed only in the absence of a verdict.
    expect(updated.provisionState).toBe(previous ?? (status ? 'unconfirmed' : undefined));
    expect(updated.readinessStale).toBe(true);
    expect(pending()).toBeUndefined();
  });

  it('records recovery advice under quota failure without redundant authentication or losing the pending key', async () => {
    const command = await prepare('restart', false);
    const storage = localStorage;
    vi.stubGlobal('localStorage', {
      getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage),
      setItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
    });
    try {
      expect(await reconcile(app, options)).toMatchObject({ outcome: 'unconfirmed', detail: expect.stringContaining('Recover the original command') });
      expect(pending()?.idempotencyKey).toBe(command.idempotencyKey);
      const { getMaintenanceRecoveryIntent } = await import('./maintenanceRecoveryIntent');
      expect(getMaintenanceRecoveryIntent(scope)?.idempotencyKey).toBe(command.idempotencyKey);
      expect(options.signing!.authTokens.getAuthToken).not.toHaveBeenCalled();
      expect(fred.getLeaseProvision).not.toHaveBeenCalled();
      expect(fred.getLeaseReleases).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('commits an update manifest despite unrelated registry changes and preserves newer readiness', async () => {
    await prepare();
    vi.mocked(fred.getLeaseReleases).mockImplementationOnce(async () => {
      options.appRegistry!.updateApp(address, app.leaseUuid, { name: 'renamed', provisionState: 'failed', url: 'https://newer.example' });
      return history(release(1, 'superseded'), release(2));
    });
    expect(await reconcile(app, options)).toMatchObject({ outcome: 'succeeded' });
    expect(options.appRegistry!.getAppByLease(address, app.leaseUuid)).toMatchObject({
      name: 'renamed', provisionState: 'failed', url: 'https://newer.example', manifest: sanitizeManifestForStorage(payload),
    });
    expect(pending()).toBeUndefined();
  });

  it('reports a verified outcome and saves its manifest even when the settled receipt cannot be written', async () => {
    const command = await prepare();
    const storage = localStorage;
    let rejectSettlement = true;
    vi.stubGlobal('localStorage', {
      getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage),
      setItem: (key: string, value: string) => {
        if (rejectSettlement && Object.hasOwn(JSON.parse(value), 'settled')) throw new Error('Storage unavailable');
        storage.setItem(key, value);
      },
    });
    try {
      const result = await reconcile(app, options);
      expect(result).toMatchObject({ outcome: 'succeeded', detail: expect.stringContaining('provider outcome was verified') });
      expect(options.appRegistry!.getAppByLease(address, app.leaseUuid)?.manifest).toBe(sanitizeManifestForStorage(payload));
      expect(pending()?.idempotencyKey).toBe(command.idempotencyKey);
      rejectSettlement = false;
      expect(await reconcile(app, options)).toMatchObject({ outcome: 'succeeded' });
      expect(pending()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each((['restart', 'update'] as const).flatMap(operation => [
    ['image pull failed', 'image pull failed.'], ['is the image private?', 'is the image private?'],
    ['image pull failed!', 'image pull failed!'], ['image pull failed…', 'image pull failed…'],
    ['image pull failed.', 'image pull failed.'], ['image pull failed:', 'image pull failed.'],
    ['provider said "no."', 'provider said "no."'],
  ].map(([message, ending]) => ({ operation, message, ending }))))('separates a reconciled $operation failure ending in "$message" from cleanup guidance and retains it on replay', async ({ operation, message, ending }) => {
    const command = await prepare(operation);
    const storage = localStorage;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('localStorage', {
      getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage),
      setItem: (key: string, value: string) => {
        if (Object.hasOwn(JSON.parse(value), 'settled')) throw new Error('Storage unavailable');
        storage.setItem(key, value);
      },
    });
    try {
      const result = await reconcile(app, options, history(release(1), release(2, 'failed', {
        reason: operation === 'restart' ? 'RestartFailed' : 'UpdateFailed', message,
      })));
      expect(result).toMatchObject({ outcome: 'failed', runtimeReady: true,
        detail: expect.stringContaining(`${ending} The provider outcome was verified`) });
      expect(result?.detail).not.toMatch(/[!?….]\. /u);
      const { getCompletedMaintenance } = await import('./maintenanceCompletion');
      const cached = getCompletedMaintenance(command);
      expect(cached?.result.result.error?.endsWith(ending)).toBe(true);
      const { executeMaintenance } = await import('./maintenanceExecution');
      const replay = await executeMaintenance({ ...scope, app_name: app.name, operation,
        idempotencyKey: command.idempotencyKey, ...(operation === 'update' && { manifest: payload }),
      }, { ...options, clientManager: {} as NonNullable<ToolExecutorOptions['clientManager']> });
      expect(replay.outcome).toBe('failed');
      expect(replay.result.error).toContain(`Previously verified ${operation}`);
      expect(replay.result.error).toContain(`${ending} The provider outcome was verified`);
      expect(replay.result.error).not.toMatch(/[!?….]\. /u);
      expect(replay.result.error).toContain('No new maintenance request was sent.');
      expect(fetch).not.toHaveBeenCalled();
      expect(fred.getLeaseProvision).toHaveBeenCalledTimes(1);
      expect(fred.getLeaseReleases).not.toHaveBeenCalled();
      expect(pending()?.idempotencyKey).toBe(command.idempotencyKey);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([false, true])('does not overwrite a successor command while reconciling an old read (successor settled: %s)', async (settleSuccessor) => {
    const first = await prepare();
    let releaseRead!: (value: FredLeaseReleases) => void;
    vi.mocked(fred.getLeaseReleases).mockImplementationOnce(() => new Promise((resolve) => { releaseRead = resolve; }));
    const observation = reconcile(app, options);
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    await operations.completeMaintenanceOperation(first);
    const successor = await operations.getOrCreateMaintenanceOperation({
      ...scope, operation: 'update', manifest: '{"image":"successor"}', baselineReleaseVersions: [1, 2], previousOperationKey: first.idempotencyKey,
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

  it('does not settle or repopulate completion memory after its session is cleared', async () => {
    const command = await prepare();
    let releaseRead!: (value: FredLeaseReleases) => void;
    vi.mocked(fred.getLeaseReleases).mockImplementationOnce(() => new Promise((resolve) => { releaseRead = resolve; }));
    const observation = reconcile(app, options);
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    const completion = await import('./maintenanceCompletion');
    completion.clearCompletedMaintenance(command);
    releaseRead(history(release(1, 'superseded'), release(2)));
    expect(await observation).toMatchObject({ outcome: 'unconfirmed' });
    expect(options.appRegistry!.updateApp).not.toHaveBeenCalled();
    expect(pending()?.idempotencyKey).toBe(command.idempotencyKey);
    expect(completion.getCompletedMaintenance(command)).toBeUndefined();
  });

  it('omits runtime readiness when a failed command is observed without a provision response', async () => {
    await prepare();
    vi.mocked(fred.getLeaseProvision).mockRejectedValueOnce(new Error('Runtime read unavailable'));
    const result = await reconcile(app, options, history(release(1), release(2, 'failed')));
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(result).not.toHaveProperty('runtimeReady');
    expect(pending()).toBeUndefined();
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
    const result = await reconcile(app, options);
    expect(result).toMatchObject({ outcome: 'unconfirmed' });
    expect(result).not.toHaveProperty('runtimeReady');
    expect(options.signing!.authTokens.getAuthToken).not.toHaveBeenCalled();
    expect(fred.getLeaseProvision).not.toHaveBeenCalled();
    expect(fred.getLeaseReleases).not.toHaveBeenCalled();
    expect(pending()?.idempotencyKey).toBe(command.idempotencyKey);
    expect(options.appRegistry!.getAppByLease(address, app.leaseUuid)?.manifest).toBe(app.manifest);
  });

  it('reuses an existing readiness observation without signing for unaccepted commands', async () => {
    await prepare('restart', false);
    expect(await reconcile(app, options, undefined, 'ready')).toMatchObject({ outcome: 'unconfirmed', runtimeReady: true });
    expect(options.signing!.authTokens.getAuthToken).not.toHaveBeenCalled();
    expect(fred.getLeaseProvision).not.toHaveBeenCalled();
    expect(fred.getLeaseReleases).not.toHaveBeenCalled();
  });

  it.each(['restarting', 'updating', 'provisioning', 'unknown'])('does not retract prior readiness on a %s maintenance observation', async (status) => {
    await prepare();
    vi.mocked(fred.getLeaseProvision).mockResolvedValue({ status, fail_count: 0 });
    expect(await reconcile(app, options)).toMatchObject({ outcome: 'unconfirmed' });
    expect(options.appRegistry!.getAppByLease(address, app.leaseUuid)).toMatchObject({ status: 'running', provisionState: 'confirmed' });
    expect(pending()).toBeDefined();
  });

  it.each([['retained', 'unconfirmed'], ['failed', 'failed'], ['failing', 'failed']] as const)('records the %s verdict during reconciliation', async (status, provisionState) => {
    await prepare();
    vi.mocked(fred.getLeaseProvision).mockResolvedValue({ status, fail_count: 1 });
    await reconcile(app, options);
    expect(options.appRegistry!.getAppByLease(address, app.leaseUuid)?.provisionState).toBe(provisionState);
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
