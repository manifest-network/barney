import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CosmosClientManager } from '@manifest-network/manifest-sdk';
import { providerFetch } from '../../api/providerFetchAdapter';
import { getLeaseReleases } from '../../api/fred';
import { runtimeConfig } from '../../config/runtimeConfig';
import type { AppEntry } from '../../registry/appRegistry';
import { executeConfirmedRestartApp, executeRestartApp, executeUpdateApp } from './compositeTransactions';
import { captureMaintenanceCompletionEpoch, clearCompletedMaintenance, MAX_COMPLETED_MAINTENANCE, rememberMaintenanceCompletion } from './maintenanceCompletion';
import { getOrCreateMaintenanceOperation, markMaintenanceOperationDispatched } from './maintenanceOperation';
import { makeRegistry } from './testHelpers';
import type { PayloadAttachment, SigningContext, ToolExecutorOptions } from './types';

vi.mock('../../config/fredCompatibility', () => ({ fredCompatibilityForProvider: () => 'pr240' }));
vi.mock('../../api/providerFetchAdapter', () => ({ providerFetch: vi.fn() }));
vi.mock('../../api/fred', async (original) => ({ ...await original<typeof import('../../api/fred')>(), getLeaseReleases: vi.fn() }));
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
  clearCompletedMaintenance(scope);
});

describe('maintenance planning admission and settled receipts', () => {
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
