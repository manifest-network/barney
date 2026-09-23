import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/errors', () => ({ logError: vi.fn() }));

type Operations = typeof import('./maintenanceOperation');
let operations: Operations;

const scope = {
  address: 'manifest1alice',
  providerUrl: 'https://provider.example',
  leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
};
const key = '11111111-1111-4111-8111-111111111111';
const manifest = '{ "services": { "web": { "image": "nginx", "env": { "PASSWORD": "private-secret" } } } }';
const previousManifest = '{"services":{"web":{"image":"nginx:old","env":{"PASSWORD":"old-private-secret"}}}}';
const restart = { ...scope, operation: 'restart' as const, baselineReleaseVersions: [1] };
const update = { ...scope, operation: 'update' as const, manifest, previousManifest, baselineReleaseVersions: [1] };

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
  operations = await import('./maintenanceOperation');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function failStorageMethod(method: 'getItem' | 'setItem' | 'removeItem'): void {
  const storage = localStorage;
  vi.stubGlobal('localStorage', {
    getItem: storage.getItem.bind(storage),
    setItem: storage.setItem.bind(storage),
    removeItem: storage.removeItem.bind(storage),
    [method]: () => { throw new Error('Storage denied'); },
  });
}

function pending() {
  return operations.getPendingMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid);
}

describe('maintenance operation retention', () => {
  it('reuses the UUIDv4 and exact update body after a lost response', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(update);
    // The caller does not complete the operation when the response is lost.
    const retried = await operations.getOrCreateMaintenanceOperation({ ...update, previousManifest: 'new chain state' });
    expect(original.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(retried.idempotencyKey).toBe(original.idempotencyKey);
    expect(retried.manifest).toBe(manifest);
    expect(retried.previousManifest).toBe(previousManifest);
    expect(Object.isFrozen(retried)).toBe(true);
  });

  it('can retry with the retained exact payload without reconstructing it', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(update);
    const retried = await operations.getOrCreateMaintenanceOperation({ ...scope, operation: 'update' });
    expect(retried.manifest).toBe(original.manifest);
    expect(retried.idempotencyKey).toBe(original.idempotencyKey);
  });

  it('persists only hashes, identifiers, operation and baseline versions', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(update);
    expect(localStorage.length).toBe(1);
    const saved = localStorage.getItem(localStorage.key(0)!)!;
    expect(JSON.parse(saved)).toEqual({
      v: 1, operation: 'update', idempotencyKey: original.idempotencyKey,
      payloadHash: original.payloadHash, baselineReleaseVersions: [1], dispatched: false, recoveryAdvised: false,
    });
    expect(saved).not.toContain('private-secret');
    expect(saved).not.toContain('nginx');
  });

  it('gives independent batch items independent keys', async () => {
    const [first, second] = await Promise.all([
      operations.getOrCreateMaintenanceOperation(restart),
      operations.getOrCreateMaintenanceOperation({ ...restart, leaseUuid: '550e8400-e29b-41d4-a716-446655440001' }),
    ]);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    const retried = await operations.getOrCreateMaintenanceOperation(restart);
    expect(retried.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('serializes concurrent callers for the same logical operation', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => operations.getOrCreateMaintenanceOperation(update)));
    expect(new Set(results.map((record) => record.idempotencyKey)).size).toBe(1);
  });

  it('rejects concurrent competing updates rather than replacing a key', async () => {
    const results = await Promise.allSettled([
      operations.getOrCreateMaintenanceOperation(update),
      operations.getOrCreateMaintenanceOperation({ ...update, manifest: `${manifest}\n` }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it.each([
    ['different operation', { ...restart }],
    ['equivalent JSON with different bytes', { ...update, manifest: JSON.stringify(JSON.parse(manifest)) }],
    ['different command key', { ...update, idempotencyKey: key }],
  ])('blocks a replacement with %s while the prior outcome is unresolved', async (_, replacement) => {
    const original = await operations.getOrCreateMaintenanceOperation(update);
    await expect(operations.getOrCreateMaintenanceOperation(replacement)).rejects.toThrow(/unresolved/);
    expect(pending()?.idempotencyKey).toBe(original.idempotencyKey);
  });

  it('retains the original release baseline across retries', async () => {
    const baseline = [1, 2];
    const original = await operations.getOrCreateMaintenanceOperation({ ...restart, baselineReleaseVersions: baseline });
    baseline.push(3);
    const retried = await operations.getOrCreateMaintenanceOperation({ ...restart, baselineReleaseVersions: [1, 2, 3, 4] });
    expect(retried.baselineReleaseVersions).toEqual([1, 2]);
    expect(original.baselineReleaseVersions).toEqual([1, 2]);
    expect(Object.isFrozen(retried.baselineReleaseVersions)).toBe(true);
  });

  it('requires a release baseline before the first dispatch', async () => {
    await expect(operations.getOrCreateMaintenanceOperation({ ...scope, operation: 'restart' })).rejects.toThrow(/release history/);
    expect(localStorage.length).toBe(0);
  });

  it('recovers a restart with the same key and original baseline after reload', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(restart);
    vi.resetModules();
    operations = await import('./maintenanceOperation');
    expect(pending()?.baselineReleaseVersions).toEqual([1]);
    const retried = await operations.getOrCreateMaintenanceOperation({ ...scope, operation: 'restart' });
    expect(retried.idempotencyKey).toBe(original.idempotencyKey);
  });

  it('blocks reloaded updates until their exact original bytes are supplied', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(update);
    vi.resetModules();
    operations = await import('./maintenanceOperation');
    expect(pending()?.manifest).toBeUndefined();
    expect(pending()?.previousManifest).toBeUndefined();
    await expect(operations.getOrCreateMaintenanceOperation({ ...scope, operation: 'update' })).rejects.toThrow(/exact original manifest bytes/);
    await expect(operations.getOrCreateMaintenanceOperation({ ...update, manifest: `${manifest}\n` })).rejects.toThrow(/different manifest bytes/);
    const retried = await operations.getOrCreateMaintenanceOperation(update);
    expect(retried.idempotencyKey).toBe(original.idempotencyKey);
    expect(retried.manifest).toBe(manifest);
    expect(retried.baselineReleaseVersions).toEqual([1]);
    expect(retried.previousManifest).toBeUndefined();
  });

  it('isolates wallets, providers, chains and lease UUIDs', async () => {
    const inputs = [
      restart,
      { ...restart, address: 'manifest1bob' },
      { ...restart, providerUrl: 'https://another-provider.example' },
      { ...restart, chainId: 'another-chain' },
      { ...restart, leaseUuid: '550e8400-e29b-41d4-a716-446655440002' },
    ];
    const results = await Promise.all(inputs.map((input) => operations.getOrCreateMaintenanceOperation(input)));
    expect(new Set(results.map((record) => record.idempotencyKey)).size).toBe(inputs.length);
  });

  it('normalizes wallet casing, provider hostname casing, default ports and trailing slashes', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(restart);
    const retried = await operations.getOrCreateMaintenanceOperation({ ...restart, address: ' MANIFEST1ALICE ', providerUrl: 'https://PROVIDER.example:443/' });
    expect(retried.idempotencyKey).toBe(original.idempotencyKey);
  });

  it('does not invent a previous manifest on retry if the original was unknown', async () => {
    await operations.getOrCreateMaintenanceOperation({ ...update, previousManifest: undefined });
    const retried = await operations.getOrCreateMaintenanceOperation(update);
    expect(retried.previousManifest).toBeUndefined();
  });

  it('retains a nonsecret receipt and refuses rebasing an already settled key', async () => {
    const original = await operations.getOrCreateMaintenanceOperation({ ...restart, idempotencyKey: key });
    await operations.completeMaintenanceOperation(original);
    expect(pending()).toBeUndefined();
    expect(localStorage.length).toBe(1);
    expect(operations.getSettledMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid)).toMatchObject({
      operation: 'restart', idempotencyKey: key, payloadHash: original.payloadHash, outcome: 'settled',
    });
    await expect(operations.getOrCreateMaintenanceOperation({ ...restart, idempotencyKey: key })).rejects.toThrow(/previous maintenance command/);
    await expect(operations.getOrCreateMaintenanceOperation({ ...restart, idempotencyKey: key, previousOperationKey: key })).rejects.toThrow(/previous maintenance command/);
  });

  it('does not let a stale completion release a newer command', async () => {
    const old = await operations.getOrCreateMaintenanceOperation(restart);
    await operations.completeMaintenanceOperation(old);
    const current = await operations.getOrCreateMaintenanceOperation({ ...restart, previousOperationKey: old.idempotencyKey });
    await operations.completeMaintenanceOperation(old);
    expect(pending()?.idempotencyKey).toBe(current.idempotencyKey);
  });

  it('preserves one nonsecret settled receipt across reloads and requires a matching new-command confirmation', async () => {
    const first = await operations.getOrCreateMaintenanceOperation(update);
    await operations.completeMaintenanceOperation(first, undefined, 'failed');
    vi.resetModules();
    operations = await import('./maintenanceOperation');
    expect(operations.getSettledMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid)).toMatchObject({
      idempotencyKey: first.idempotencyKey, outcome: 'failed',
    });
    expect(localStorage.getItem(localStorage.key(0)!)!).not.toMatch(/private-secret|nginx|manifest/);
    await expect(operations.getOrCreateMaintenanceOperation(restart)).rejects.toThrow(/previous maintenance command/);
    const next = await operations.getOrCreateMaintenanceOperation({ ...restart, previousOperationKey: first.idempotencyKey });
    await operations.completeMaintenanceOperation(next, undefined, 'succeeded');
    expect(localStorage.length).toBe(1);
    expect(operations.getSettledMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid)?.idempotencyKey).toBe(next.idempotencyKey);
    await expect(operations.getOrCreateMaintenanceOperation({ ...restart, previousOperationKey: first.idempotencyKey })).rejects.toThrow(/previous maintenance command/);
    await operations.retireAbsentMaintenanceOperation(scope);
    expect(localStorage.length).toBe(0);
  });

  it('retains the pending marker when its settled receipt cannot be saved', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(update);
    failStorageMethod('setItem');
    await expect(operations.completeMaintenanceOperation(original)).rejects.toThrow(/storage access/);
    expect(pending()?.idempotencyKey).toBe(original.idempotencyKey);
  });

  it.each([undefined, false, true])('settles without growing UTF-16 storage usage, including minimal legacy metadata (advised: %s)', async (advised) => {
    const command = await operations.getOrCreateMaintenanceOperation({ ...restart, baselineReleaseVersions: [] });
    const markerKey = localStorage.key(0)!;
    localStorage.setItem(markerKey, JSON.stringify({ v: 1, operation: command.operation, idempotencyKey: command.idempotencyKey,
      payloadHash: command.payloadHash, baselineReleaseVersions: [], ...(advised !== undefined && { recoveryAdvised: advised }) }));
    const storage = localStorage;
    const usage = () => Array.from({ length: storage.length }, (_, index) => storage.key(index)!)
      .reduce((bytes, key) => bytes + 2 * (key.length + storage.getItem(key)!.length), 0);
    const quota = usage();
    vi.stubGlobal('localStorage', {
      getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage),
      setItem: (key: string, value: string) => {
        const old = storage.getItem(key);
        const projected = usage() - (old === null ? 0 : 2 * (key.length + old.length)) + 2 * (key.length + value.length);
        if (projected > quota) throw new DOMException('Quota reached', 'QuotaExceededError');
        storage.setItem(key, value);
      },
    });
    await operations.completeMaintenanceOperation(command, undefined, 'succeeded');
    expect(pending()).toBeUndefined();
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe(markerKey);
    expect(usage()).toBeLessThan(quota);
    expect(operations.getSettledMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid)).toMatchObject({
      outcome: 'succeeded', recoveryAdvised: advised ?? true,
    });
  });

  it('records advice from another tab on settlement without blocking routine direct results', async () => {
    const command = await operations.getOrCreateMaintenanceOperation(restart);
    vi.resetModules();
    const otherTab = await import('./maintenanceOperation');
    await otherTab.markMaintenanceRecoveryAdvised(command);
    await operations.completeMaintenanceOperation(command, undefined, 'failed');
    expect(operations.getSettledMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid)?.recoveryAdvised).toBe(true);
    const next = await operations.getOrCreateMaintenanceOperation({ ...restart, previousOperationKey: command.idempotencyKey, recoveryIntentKey: command.idempotencyKey });
    await operations.completeMaintenanceOperation(next, undefined, 'succeeded');
    expect(operations.getSettledMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid)?.recoveryAdvised).toBe(false);
  });

  it('keeps recovery advice in memory when both storage writes fail and another tab settles without seeing it', async () => {
    const sessionWrites = vi.fn(() => { throw new Error('Quota exceeded'); });
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: sessionWrites, removeItem: vi.fn() });
    vi.resetModules();
    operations = await import('./maintenanceOperation');
    const command = await operations.getOrCreateMaintenanceOperation(restart);
    const storage = localStorage;
    const writes = vi.fn(() => { throw new Error('Quota exceeded'); });
    vi.stubGlobal('localStorage', {
      getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage), setItem: writes,
    });
    await expect(operations.markMaintenanceRecoveryAdvised(command)).resolves.toBeUndefined();
    expect(writes).toHaveBeenCalledOnce();
    expect(sessionWrites).toHaveBeenCalledOnce();
    expect(JSON.parse(storage.getItem(storage.key(0)!)!).recoveryAdvised).toBe(false);
    vi.stubGlobal('localStorage', storage);
    const { getMaintenanceRecoveryIntent } = await import('./maintenanceRecoveryIntent');
    expect(getMaintenanceRecoveryIntent(scope)?.idempotencyKey).toBe(command.idempotencyKey);
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    vi.resetModules();
    const otherTab = await import('./maintenanceOperation');
    await otherTab.completeMaintenanceOperation(command, undefined, 'succeeded');
    expect(otherTab.getSettledMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid)?.recoveryAdvised).toBe(false);
    await expect(operations.getOrCreateMaintenanceOperation({ ...restart, previousOperationKey: command.idempotencyKey })).rejects.toThrow(/recovery advice/);
  });

  it('retains late advice only in this tab without growing or poisoning another tab’s routine settled receipt', async () => {
    const command = await operations.getOrCreateMaintenanceOperation(restart);
    await operations.completeMaintenanceOperation(command, undefined, 'succeeded');
    const storage = localStorage;
    const writes = vi.fn(() => { throw new Error('Quota exceeded'); });
    vi.stubGlobal('localStorage', {
      getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage), setItem: writes,
    });
    await expect(operations.markMaintenanceRecoveryAdvised(command)).resolves.toBeUndefined();
    expect(writes).not.toHaveBeenCalled();
    expect(operations.getSettledMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid)?.recoveryAdvised).toBe(false);
    await expect(operations.getOrCreateMaintenanceOperation({ ...restart, previousOperationKey: command.idempotencyKey })).rejects.toThrow(/recovery advice/);
  });

  it('restores a blocking receipt if a prepared successor is discarded after reload', async () => {
    const command = await operations.getOrCreateMaintenanceOperation(update);
    await operations.markMaintenanceRecoveryAdvised(command);
    await operations.completeMaintenanceOperation(command, undefined, 'failed');
    const successor = await operations.getOrCreateMaintenanceOperation({ ...restart, previousOperationKey: command.idempotencyKey, recoveryIntentKey: command.idempotencyKey });
    vi.resetModules();
    const otherTab = await import('./maintenanceOperation');
    expect(await otherTab.discardUnsubmittedMaintenanceOperation(successor)).toBe(true);
    expect(otherTab.getSettledMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid)).toMatchObject({
      idempotencyKey: command.idempotencyKey, recoveryAdvised: true,
    });
    expect(JSON.stringify(localStorage)).not.toContain('private-secret');
    await expect(otherTab.getOrCreateMaintenanceOperation(restart)).rejects.toThrow(/recovery advice/);
  });

  it('reads legacy separate receipts conservatively and migrates them on the next settlement', async () => {
    const command = await operations.getOrCreateMaintenanceOperation(restart);
    const markerKey = localStorage.key(0)!;
    localStorage.removeItem(markerKey);
    localStorage.setItem(`${markerKey}:settled`, JSON.stringify({ v: 1, operation: command.operation,
      idempotencyKey: command.idempotencyKey, payloadHash: command.payloadHash, outcome: 'succeeded' }));
    expect(operations.getSettledMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid)).toMatchObject({ recoveryAdvised: true });
    const next = await operations.getOrCreateMaintenanceOperation({ ...restart, previousOperationKey: command.idempotencyKey });
    await operations.completeMaintenanceOperation(next, undefined, 'succeeded');
    expect(localStorage.getItem(`${markerKey}:settled`)).toBeNull();
    expect(localStorage.length).toBe(1);
    expect(operations.getSettledMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid)).toMatchObject({
      idempotencyKey: next.idempotencyKey, recoveryAdvised: false,
    });
  });

  it('forgets stale in-memory commands when the durable marker is cleared', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(restart);
    localStorage.clear();
    expect(pending()).toBeUndefined();
    const next = await operations.getOrCreateMaintenanceOperation(restart);
    expect(next.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(localStorage.length).toBe(1);
  });

  it('observes another tab completing a retained update and can prepare a new restart', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(update);
    vi.resetModules();
    const secondTab = await import('./maintenanceOperation');
    await secondTab.completeMaintenanceOperation(original);
    expect(pending()).toBeUndefined();
    await expect(operations.getOrCreateMaintenanceOperation(restart)).rejects.toThrow(/previous maintenance command/);
    const next = await operations.getOrCreateMaintenanceOperation({ ...restart, previousOperationKey: original.idempotencyKey });
    expect(next.operation).toBe('restart');
    expect(next.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(next.manifest).toBeUndefined();
  });

  it('adopts another tab’s newer metadata without retaining the prior raw payload', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(update);
    vi.resetModules();
    const secondTab = await import('./maintenanceOperation');
    await secondTab.completeMaintenanceOperation(original);
    const next = await secondTab.getOrCreateMaintenanceOperation({ ...restart, previousOperationKey: original.idempotencyKey });
    expect(pending()).toMatchObject({ operation: 'restart', idempotencyKey: next.idempotencyKey });
    expect(pending()?.manifest).toBeUndefined();
    expect(pending()?.previousManifest).toBeUndefined();
  });

  it('refuses recovery when the saved marker is gone instead of creating it again', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(update);
    localStorage.clear();
    await expect(operations.prepareMaintenanceOperation({
      ...update, idempotencyKey: original.idempotencyKey, expectPending: true,
    })).rejects.toThrow(/no longer exists/);
    expect(localStorage.length).toBe(0);
    expect(pending()).toBeUndefined();
  });

  it('does not resurrect a pending snapshot removed while preparation waits for its lock', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(update);
    let notifyQueued!: () => void;
    const queued = new Promise<void>((resolve) => { notifyQueued = resolve; });
    let releaseLock!: () => void;
    const heldLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    vi.stubGlobal('navigator', {
      locks: { request: async (_name: string, action: () => unknown) => {
        notifyQueued();
        await heldLock;
        return action();
      } },
    });
    const preparation = operations.prepareMaintenanceOperation({ ...update, idempotencyKey: original.idempotencyKey });
    const rejected = expect(preparation).rejects.toThrow(/no longer exists/);
    await queued;
    localStorage.clear(); // Another tab settled the command before this lock was acquired.
    releaseLock();
    await rejected;
    expect(localStorage.length).toBe(0);
    expect(pending()).toBeUndefined();
  });

  it('drops a stale raw payload when committing an observation finds its marker absent', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(update);
    const storageKey = localStorage.key(0)!;
    const metadata = localStorage.getItem(storageKey)!;
    localStorage.clear();
    const apply = vi.fn();
    expect(await operations.commitMaintenanceObservation(original, {
      settled: true, isCurrent: () => true, apply,
    })).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    // If that identity is observed again, only durable metadata may be used.
    localStorage.setItem(storageKey, metadata);
    expect(pending()?.manifest).toBeUndefined();
    expect(pending()?.previousManifest).toBeUndefined();
  });

  it.each(['getItem', 'setItem'] as const)('fails closed when storage %s fails', async (method) => {
    failStorageMethod(method);
    await expect(operations.getOrCreateMaintenanceOperation(restart)).rejects.toThrow(/browser storage access/);
  });

  it('settles through a same-key overwrite even when obsolete separate-receipt cleanup fails', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(restart);
    failStorageMethod('removeItem');
    await expect(operations.completeMaintenanceOperation(original)).resolves.toBeUndefined();
    expect(pending()).toBeUndefined();
    expect(operations.getSettledMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid)?.idempotencyKey).toBe(original.idempotencyKey);
  });

  it('does not replace unreadable durable recovery metadata', async () => {
    await operations.getOrCreateMaintenanceOperation(restart);
    const storageKey = localStorage.key(0)!;
    localStorage.setItem(storageKey, '{broken');
    await expect(operations.getOrCreateMaintenanceOperation(restart)).rejects.toThrow(/unreadable/);
    expect(localStorage.getItem(storageKey)).toBe('{broken');
  });

  it('acquires the shared browser lock before clearing and rechecks for a newer command', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(restart);
    const storageKey = localStorage.key(0)!;
    let releaseLock!: () => void;
    const request = vi.fn((_name: string, action: () => void) => new Promise<void>((resolve) => {
      releaseLock = () => { action(); resolve(); };
    }));
    vi.stubGlobal('navigator', { locks: { request } });
    const completion = operations.completeMaintenanceOperation(original);
    expect(request).toHaveBeenCalledWith(storageKey, expect.any(Function));
    expect(JSON.parse(localStorage.getItem(storageKey)!).idempotencyKey).toBe(original.idempotencyKey);

    // Another tab finishes the prior command and saves a new command before
    // this tab acquires its queued lock. A stale result must not erase it.
    const newer = { ...JSON.parse(localStorage.getItem(storageKey)!), idempotencyKey: key };
    localStorage.setItem(storageKey, JSON.stringify(newer));
    releaseLock();
    await completion;
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(newer);
  });

  it('checks completion authorization inside the queued lock before clearing metadata', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(update);
    let releaseLock!: () => void;
    const heldLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, action: () => unknown) => {
      await heldLock;
      return action();
    } } });
    let current = true;
    const completion = operations.completeMaintenanceOperation(original, () => {
      if (!current) throw new Error('Wallet authorization changed');
    });
    const rejected = expect(completion).rejects.toThrow('Wallet authorization changed');
    current = false;
    releaseLock();
    await rejected;
    expect(pending()?.idempotencyKey).toBe(original.idempotencyKey);
  });


  it('persists acknowledgement for read-only reconciliation after reload', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(update);
    await operations.markMaintenanceOperationDispatched(original);
    await operations.markMaintenanceOperationAccepted(original);
    vi.resetModules();
    operations = await import('./maintenanceOperation');
    expect(pending()).toMatchObject({ accepted: true, dispatched: true });
    expect(pending()?.manifest).toBeUndefined();
  });

  it('discards a newly prepared command only while it remains unsubmitted', async () => {
    const prepared = await operations.prepareMaintenanceOperation(restart);
    expect(prepared.created).toBe(true);
    const retry = await operations.prepareMaintenanceOperation(restart);
    expect(retry.created).toBe(false);
    expect(await operations.discardUnsubmittedMaintenanceOperation(prepared.command)).toBe(true);
    expect(pending()).toBeUndefined();
  });

  it('retains a prepared command once a concurrent caller starts HTTP', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(restart);
    await operations.markMaintenanceOperationDispatched(original);
    expect(await operations.discardUnsubmittedMaintenanceOperation(original)).toBe(false);
    expect(pending()?.idempotencyKey).toBe(original.idempotencyKey);
  });

  it('does not assume a legacy saved record was never dispatched', async () => {
    const original = await operations.getOrCreateMaintenanceOperation(restart);
    const storageKey = localStorage.key(0)!;
    const metadata = JSON.parse(localStorage.getItem(storageKey)!);
    delete metadata.dispatched;
    localStorage.setItem(storageKey, JSON.stringify(metadata));
    vi.resetModules();
    operations = await import('./maintenanceOperation');
    expect(await operations.discardUnsubmittedMaintenanceOperation(original)).toBe(false);
  });

  it('retires absent-lease metadata even when it cannot be parsed', async () => {
    await operations.getOrCreateMaintenanceOperation(restart);
    localStorage.setItem(localStorage.key(0)!, '{broken');
    await operations.retireAbsentMaintenanceOperation(scope);
    expect(pending()).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });

  it('treats absent-lease cleanup as best effort when the provider URL is invalid', async () => {
    await operations.getOrCreateMaintenanceOperation(update);
    await expect(operations.retireAbsentMaintenanceOperation({ ...scope, providerUrl: 'invalid-url' })).resolves.toBeUndefined();
    expect(pending()?.manifest).toBeUndefined();
    expect(pending()?.previousManifest).toBeUndefined();
  });

  it('logs absent-lease storage cleanup failures and still drops memory-only payloads', async () => {
    await operations.getOrCreateMaintenanceOperation(update);
    const { logError } = await import('../../utils/errors');
    failStorageMethod('removeItem');
    await expect(operations.retireAbsentMaintenanceOperation(scope)).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith('maintenanceOperation.retireAbsent', expect.any(Error));
    expect(pending()?.manifest).toBeUndefined();
    expect(pending()?.previousManifest).toBeUndefined();
  });

  it('rejects invalid caller-provided operation keys before creating a marker', async () => {
    await expect(operations.getOrCreateMaintenanceOperation({ ...restart, idempotencyKey: 'not-uuid-v4' })).rejects.toThrow(/UUIDv4/);
    expect(localStorage.length).toBe(0);
  });
});
