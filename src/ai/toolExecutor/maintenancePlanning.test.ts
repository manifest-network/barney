import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CosmosClientManager } from '@manifest-network/manifest-sdk';
import { providerFetch } from '../../api/providerFetchAdapter';
import { getLeaseProvision, getLeaseReleases } from '../../api/fred';
import { runtimeConfig } from '../../config/runtimeConfig';
import type { AppEntry } from '../../registry/appRegistry';
import { executeConfirmedRestartApp, executeRestartApp, executeUpdateApp } from './compositeTransactions';
import { canPlanMaintenanceCompletions, captureMaintenanceCompletionEpoch, clearCompletedMaintenance, MAX_COMPLETED_MAINTENANCE, releaseMaintenanceCompletionReservation, rememberMaintenanceCompletion, reserveMaintenanceCompletions } from './maintenanceCompletion';
import { completeMaintenanceOperation, getOrCreateMaintenanceOperation, markMaintenanceOperationAccepted, markMaintenanceOperationDispatched, markMaintenanceRecoveryAdvised, retireAbsentMaintenanceOperation } from './maintenanceOperation';
import { makeRegistry } from './testHelpers';
import type { PayloadAttachment, SigningContext, ToolExecutorOptions } from './types';

vi.mock('../../config/fredCompatibility', () => ({ fredCompatibilityForProvider: () => 'pr240' }));
vi.mock('../../api/providerFetchAdapter', () => ({ providerFetch: vi.fn() }));
vi.mock('../../api/fred', async (original) => ({ ...await original<typeof import('../../api/fred')>(), getLeaseProvision: vi.fn(), getLeaseReleases: vi.fn() }));
vi.mock('./capabilityCtx', () => ({ buildBarneyCtx: vi.fn().mockResolvedValue({}) }));

const address = 'manifest1planning';
const providerUrl = 'https://provider.example';
const manifest = '{"image":"nginx:new"}';
const chain = {} as CosmosClientManager;
const scope = { address, chainId: runtimeConfig.PUBLIC_CHAIN_ID };

function setup() {
  const app: AppEntry = {
    name: 'example', leaseUuid: crypto.randomUUID(), providerUrl, providerUuid: 'provider', size: 'small',
    createdAt: 1, status: 'running', chainState: 'active', provisionState: 'confirmed', manifest: '{"image":"nginx:old"}',
  };
  const token = vi.fn().mockResolvedValue('token');
  const options: ToolExecutorOptions = {
    address, appRegistry: makeRegistry([app]), tiers: [], clientManager: chain,
    signing: { authTokens: { getAuthToken: token } } as unknown as SigningContext,
  };
  return { app, options, token };
}

function payload(): PayloadAttachment {
  const bytes = new TextEncoder().encode(manifest);
  return { bytes, filename: 'update.json', size: bytes.length, hash: 'a'.repeat(64) };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  clearCompletedMaintenance(scope);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function isolatedSessionStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); }, key: (index) => [...values.keys()][index] ?? null,
  };
}

describe('maintenance planning admission and settled receipts', () => {
  it.each(['restart', 'update'] as const)('keeps %s observation-only when recovery advice survives a missing command record, even for an explicit new command', async (operation) => {
    const { app, options } = setup();
    const command = await getOrCreateMaintenanceOperation({
      ...scope, providerUrl, leaseUuid: app.leaseUuid, operation, baselineReleaseVersions: [1],
      ...(operation === 'update' && { manifest }),
    });
    await markMaintenanceOperationDispatched(command);
    localStorage.clear();
    // A late response can retain advice even if another context removed the
    // command marker. That absence cannot establish a provider verdict.
    await markMaintenanceRecoveryAdvised(command);
    for (const new_command of [false, true]) {
      const args = { app_name: app.name, new_command };
      for (const result of [await executeRestartApp(args, options), await executeUpdateApp(args, options, payload())]) {
        expect(result.requiresConfirmation).toBeUndefined();
        expect(result.error).toContain('outcome remains unknown');
        expect(result.error).not.toContain('already settled');
      }
    }
    await expect(getOrCreateMaintenanceOperation({ ...scope, providerUrl, leaseUuid: app.leaseUuid,
      operation: 'restart', recoveryIntentKey: command.idempotencyKey, baselineReleaseVersions: [1] })).rejects.toThrow(/outcome remains unknown/);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('keeps tab A’s old recovery advice guarded across a deliberate successor and reload without blocking tab B’s routine work', async () => {
    const { app, options } = setup();
    const tabAStorage = sessionStorage;
    const command = await getOrCreateMaintenanceOperation({
      ...scope, providerUrl, leaseUuid: app.leaseUuid, operation: 'restart', baselineReleaseVersions: [1],
    });
    await markMaintenanceRecoveryAdvised(command);
    vi.stubGlobal('sessionStorage', isolatedSessionStorage());
    vi.resetModules();
    const tabB = await import('./maintenanceOperation');
    const tabBTools = await import('./compositeTransactions');
    await tabB.completeMaintenanceOperation(command, undefined, 'succeeded');
    const deliberate = await tabBTools.executeRestartApp({ app_name: app.name, new_command: true }, options);
    expect(deliberate.requiresConfirmation).toBe(true);
    const successor = await tabB.getOrCreateMaintenanceOperation({ ...scope, providerUrl, leaseUuid: app.leaseUuid,
      operation: 'restart', idempotencyKey: deliberate.pendingAction!.args.idempotencyKey as string,
      previousOperationKey: command.idempotencyKey, baselineReleaseVersions: [1, 2] });
    await tabB.markMaintenanceOperationDispatched(successor);
    await tabB.completeMaintenanceOperation(successor, undefined, 'succeeded');
    expect(tabB.getSettledMaintenanceOperation(address, providerUrl, app.leaseUuid)?.recoveryAdvised).toBe(false);
    expect((await tabBTools.executeRestartApp({ app_name: app.name }, options)).requiresConfirmation).toBe(true);

    vi.stubGlobal('sessionStorage', tabAStorage);
    vi.resetModules();
    const tabA = await import('./compositeTransactions');
    for (const next of [await tabA.executeRestartApp({ app_name: app.name }, options), await tabA.executeUpdateApp({ app_name: app.name }, options, payload())]) {
      expect(next.requiresConfirmation).toBeUndefined();
      expect(next.error).toContain('has already settled');
    }
    const approvedNew = await tabA.executeRestartApp({ app_name: app.name, new_command: true }, options);
    expect(approvedNew.pendingAction?.args).toMatchObject({ recoveryIntentKey: command.idempotencyKey, previousOperationKey: successor.idempotencyKey });
    // Showing a card never consumes the old advice.
    expect((await tabA.executeRestartApp({ app_name: app.name }, options)).requiresConfirmation).toBeUndefined();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each(['succeeded', 'failed'] as const)('preserves older retry advice after a legacy pending update settles %s through a reloaded status read', async (outcome) => {
    const { app, options } = setup();
    const command = await getOrCreateMaintenanceOperation({
      ...scope, providerUrl, leaseUuid: app.leaseUuid, operation: 'update', manifest, baselineReleaseVersions: [1],
    });
    await markMaintenanceOperationAccepted(command);
    const markerKey = localStorage.key(0)!;
    const metadata = JSON.parse(localStorage.getItem(markerKey)!);
    delete metadata.recoveryAdvised; // a3e175c pending format, which already issued retry advice
    localStorage.setItem(markerKey, JSON.stringify(metadata));
    vi.mocked(getLeaseProvision).mockResolvedValueOnce({ status: 'ready', fail_count: outcome === 'failed' ? 1 : 0 });
    vi.resetModules();
    const { reconcilePendingMaintenance } = await import('./maintenanceReconciliation');
    const result = await reconcilePendingMaintenance(app, options, {
      lease_uuid: app.leaseUuid, tenant: address, provider_uuid: app.providerUuid,
      releases: [
        { version: 1, status: outcome === 'succeeded' ? 'superseded' : 'active', image: 'nginx:old', created_at: '2026-09-23T00:00:00Z' },
        { version: 2, status: outcome === 'succeeded' ? 'active' : 'failed', image: 'nginx:new', created_at: '2026-09-23T00:00:01Z', manifest: btoa(manifest) },
      ],
    });
    expect(result).toMatchObject({ outcome });
    for (const next of [
      await executeRestartApp({ app_name: app.name }, options),
      await executeUpdateApp({ app_name: app.name }, options, payload()),
    ]) {
      expect(next.requiresConfirmation).toBeUndefined();
      expect(next.error).toContain('has already settled');
    }
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('refuses an update before showing confirmation when the session is full', async () => {
    const { app, options } = setup();
    const epoch = captureMaintenanceCompletionEpoch(scope);
    for (let i = 0; i < MAX_COMPLETED_MAINTENANCE; i++) rememberMaintenanceCompletion({
      ...scope, providerUrl, leaseUuid: app.leaseUuid, operation: 'update', idempotencyKey: crypto.randomUUID(),
      payloadHash: 'a'.repeat(64), baselineReleaseVersions: [1],
    }, { outcome: 'succeeded', result: { success: true, data: {} } }, epoch);
    const result = await executeUpdateApp({ app_name: app.name }, options, payload());
    expect(result.requiresConfirmation).toBeUndefined();
    expect(result.error).toContain('maintenance confirmation limit');
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each(['restart', 'update'] as const)('does not repeat a %s after another tab settles the command named in earlier retry advice', async (operation) => {
    const { app, options, token } = setup();
    const command = await getOrCreateMaintenanceOperation({
      ...scope, providerUrl, leaseUuid: app.leaseUuid, operation, baselineReleaseVersions: [1],
      ...(operation === 'update' ? { manifest } : {}),
    });
    await markMaintenanceOperationDispatched(command);
    await markMaintenanceRecoveryAdvised(command);
    // This module still retains the command bytes from the lost-response attempt.
    // A separate module instance models the other tab settling it through status.
    vi.resetModules();
    const otherTab = await import('./maintenanceOperation');
    await otherTab.completeMaintenanceOperation(command, undefined, 'succeeded');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = operation === 'restart'
        ? await executeRestartApp({ app_name: app.name }, options)
        : await executeUpdateApp({ app_name: app.name }, options);
      expect(result.requiresConfirmation).toBeUndefined();
      expect(result.error).toContain('has already settled');
    }
    const next = operation === 'restart'
      ? await executeRestartApp({ app_name: app.name, new_command: true }, options)
      : await executeUpdateApp({ app_name: app.name, new_command: true }, options, payload());
    expect(next.requiresConfirmation).toBe(true);
    expect(next.pendingAction?.args.previousOperationKey).toBe(command.idempotencyKey);
    expect(next.pendingAction?.args.idempotencyKey).not.toBe(command.idempotencyKey);
    expect(next.confirmationMessage).toContain('NEW command');
    expect(token).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['succeeded', 'file'], ['failed', 'file'], ['succeeded', 'image'], ['failed', 'image'], ['succeeded', 'services'],
  ] as const)('plans a routine %s update with %s input on its first request after a directly reported result', async (outcome, input) => {
    const { app, options } = setup();
    const command = await getOrCreateMaintenanceOperation({
      ...scope, providerUrl, leaseUuid: app.leaseUuid, operation: 'update', manifest, baselineReleaseVersions: [1],
    });
    await completeMaintenanceOperation(command, undefined, outcome);
    const args = input === 'image' ? { app_name: app.name, image: 'nginx:next', ports: '80' }
      : input === 'services' ? { app_name: app.name, services: JSON.stringify({ web: { image: 'nginx:next', ports: '80' } }) }
        : { app_name: app.name };
    const result = await executeUpdateApp(args, options, input === 'file' ? payload() : undefined);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.pendingAction?.args.previousOperationKey).toBe(command.idempotencyKey);
    expect(result.pendingAction?.args.idempotencyKey).not.toBe(command.idempotencyKey);
    expect(result.pendingAction?.args._generatedManifest).toEqual(expect.any(String));
    expect(result.confirmationMessage).not.toContain('NEW command');
  });

  it.each([false, true])('releases a closed lease reservation with storage cleanup failing: %s', async (cleanupFails) => {
    const { app } = setup();
    const command = await getOrCreateMaintenanceOperation({
      ...scope, providerUrl, leaseUuid: app.leaseUuid, operation: 'restart', baselineReleaseVersions: [1],
    });
    await markMaintenanceOperationDispatched(command);
    const epoch = captureMaintenanceCompletionEpoch(scope);
    const reservation = reserveMaintenanceCompletions([command], epoch)!;
    releaseMaintenanceCompletionReservation(reservation, true);
    for (let i = 0; i < MAX_COMPLETED_MAINTENANCE - 1; i++) rememberMaintenanceCompletion({
      ...command, idempotencyKey: crypto.randomUUID(),
    }, { outcome: 'succeeded', result: { success: true, data: {} } }, epoch);
    expect(canPlanMaintenanceCompletions(scope, 1)).toBe(false);
    if (cleanupFails) vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    await retireAbsentMaintenanceOperation(command);
    expect(canPlanMaintenanceCompletions(scope, 1)).toBe(true);
    // An in-flight callback cannot pin the already-closed lease again.
    releaseMaintenanceCompletionReservation(reservation, true);
    expect(canPlanMaintenanceCompletions(scope, 1)).toBe(true);
  });

  it('refuses new update intent while allowing recovery of the exact pending update', async () => {
    const { app, options } = setup();
    const command = await getOrCreateMaintenanceOperation({
      ...scope, providerUrl, leaseUuid: app.leaseUuid, operation: 'update', manifest, baselineReleaseVersions: [1],
    });
    const refused = await executeUpdateApp({ app_name: app.name, new_command: true }, options, payload());
    expect(refused.error).toContain('new command cannot replace it');
    expect(refused.requiresConfirmation).toBeUndefined();
    const recovery = await executeUpdateApp({ app_name: app.name, new_command: false }, options);
    expect(recovery.pendingAction?.args).toMatchObject({ idempotencyKey: command.idempotencyKey, _maintenanceRetry: true });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('keeps a stale confirmed batch recovery observation-only without authentication, baseline reads, or POSTs', async () => {
    const { app, options, token } = setup();
    const command = await getOrCreateMaintenanceOperation({
      ...scope, providerUrl, leaseUuid: app.leaseUuid, operation: 'restart', baselineReleaseVersions: [1],
    });
    const confirmation = await executeRestartApp({ app_name: 'all' }, options);
    vi.resetModules();
    const otherTab = await import('./maintenanceOperation');
    await otherTab.completeMaintenanceOperation(command, undefined, 'succeeded');
    const result = await executeConfirmedRestartApp(confirmation.pendingAction!.args, chain, options);
    expect(result.data).toMatchObject({
      unconfirmed: [expect.objectContaining({ name: app.name })],
      message: expect.stringContaining('Outcome unknown'),
    });
    expect(JSON.stringify(result)).toContain('app_status');
    expect(JSON.stringify(result)).not.toContain('Retry restart_app');
    expect(token).not.toHaveBeenCalled();
    expect(getLeaseReleases).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
