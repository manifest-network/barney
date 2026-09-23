import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEntry } from '../../registry/appRegistry';
import { executeConfirmedRestartApp, executeRestartApp } from './compositeTransactions';
import { executeMaintenance } from './maintenanceExecution';
import { getPendingMaintenanceOperation, type MaintenanceOperation } from './maintenanceOperation';
import { makeRegistry } from './testHelpers';
import type { ToolExecutorOptions } from './types';

vi.mock('../../config/fredCompatibility', () => ({ fredCompatibilityForProvider: () => 'pr240' }));
vi.mock('./maintenanceOperation', () => ({ getPendingMaintenanceOperation: vi.fn() }));
vi.mock('./maintenanceExecution', () => ({ executeMaintenance: vi.fn() }));
vi.mock('./capabilityCtx', () => ({ buildBarneyCtx: vi.fn().mockResolvedValue({}) }));

const address = 'manifest1alice';
const providerUrl = 'https://provider.example';
const restartKey = '11111111-1111-4111-8111-111111111111';
const updateKey = '22222222-2222-4222-8222-222222222222';
const leaseUuid = (number: number) => `550e8400-e29b-41d4-a716-${String(number).padStart(12, '0')}`;

function app(name: string, number: number, overrides: Partial<AppEntry> = {}): AppEntry {
  return { name, leaseUuid: leaseUuid(number), providerUrl, providerUuid: 'provider', size: 'small',
    createdAt: 1, status: 'running', chainState: 'active', provisionState: 'confirmed', ...overrides };
}

function options(apps: AppEntry[]): ToolExecutorOptions {
  return { clientManager: null, address, appRegistry: makeRegistry(apps), tiers: [] };
}

function pending(operation: 'restart' | 'update'): MaintenanceOperation {
  return { address, providerUrl, leaseUuid: leaseUuid(1), chainId: 'chain', operation,
    idempotencyKey: operation === 'restart' ? restartKey : updateKey,
    payloadHash: 'a'.repeat(64), baselineReleaseVersions: [1] };
}

beforeEach(() => vi.resetAllMocks());

describe('restart selection and saved operations', () => {
  it('does not inspect unrelated corrupt metadata for a named restart', async () => {
    vi.mocked(getPendingMaintenanceOperation).mockImplementation((_address, _provider, lease) => {
      if (lease === leaseUuid(2)) throw new Error('Saved operation is unreadable');
      return undefined;
    });
    const result = await executeRestartApp({ app_name: 'web' }, options([app('web', 1), app('corrupt', 2)]));
    expect(result.requiresConfirmation).toBe(true);
    expect(getPendingMaintenanceOperation).toHaveBeenCalledTimes(1);
    expect(getPendingMaintenanceOperation).toHaveBeenCalledWith(address, providerUrl, leaseUuid(1), undefined);
  });

  it('scopes comma-separated metadata reads to deduplicated selected leases', async () => {
    const result = await executeRestartApp({ app_name: 'web,cache,web' }, options([app('web', 1), app('cache', 2), app('unrelated', 3)]));
    expect(result.pendingAction?.args.entries).toHaveLength(2);
    expect(vi.mocked(getPendingMaintenanceOperation).mock.calls.map((call) => call[2])).toEqual([leaseUuid(1), leaseUuid(2)]);
    const entries = result.pendingAction?.args.entries as Array<{ idempotencyKey: string }>;
    expect(entries[0].idempotencyKey).not.toBe(entries[1].idempotencyKey);
  });

  it('skips a chain-absent pending restart so restart all reaches healthy apps', async () => {
    vi.mocked(getPendingMaintenanceOperation).mockImplementation((_address, _provider, lease) => lease === leaseUuid(1) ? pending('restart') : undefined);
    const result = await executeRestartApp({ app_name: 'all' }, options([
      app('closed', 1, { chainState: 'absent', status: 'stopped' }), app('web', 2),
    ]));
    expect(result.pendingAction?.args.entries).toEqual([expect.objectContaining({ app_name: 'web' })]);
    expect(result.confirmationMessage).not.toContain('closed');
    expect(result.confirmationMessage).not.toContain('skipped');
    expect(getPendingMaintenanceOperation).toHaveBeenCalledTimes(1);
  });

  it('rejects a single chain-absent app before reading pending metadata', async () => {
    const result = await executeRestartApp({ app_name: 'closed' }, options([app('closed', 1, { chainState: 'absent', status: 'stopped' })]));
    expect(result.error).toContain('no active lease');
    expect(getPendingMaintenanceOperation).not.toHaveBeenCalled();
  });

  it.each(['all', 'corrupt,web'])('isolates unreadable records in %s with named skipped diagnostics', async (app_name) => {
    vi.mocked(getPendingMaintenanceOperation).mockImplementation((_address, _provider, lease) => {
      if (lease === leaseUuid(1)) throw new Error('Saved operation is unreadable');
      return undefined;
    });
    const result = await executeRestartApp({ app_name }, options([app('corrupt', 1), app('web', 2)]));
    expect(result.pendingAction?.args.entries).toEqual([expect.objectContaining({ app_name: 'web' })]);
    expect(result.confirmationMessage).toContain('skipped: App "corrupt": Saved operation is unreadable');
  });

  it('returns the selected app name and storage error when its record is unreadable', async () => {
    vi.mocked(getPendingMaintenanceOperation).mockImplementation(() => { throw new Error('Saved operation is unreadable'); });
    const result = await executeRestartApp({ app_name: 'corrupt' }, options([app('corrupt', 1)]));
    expect(result.error).toContain('App "corrupt": Saved operation is unreadable');
    expect(result.requiresConfirmation).toBeUndefined();
  });

  it.each(['all', 'updating,web'])('never reuses an unresolved update key in a %s restart plan', async (app_name) => {
    vi.mocked(getPendingMaintenanceOperation).mockImplementation((_address, _provider, lease) => lease === leaseUuid(1) ? pending('update') : undefined);
    const result = await executeRestartApp({ app_name }, options([app('updating', 1), app('web', 2)]));
    expect(result.pendingAction?.args.entries).toEqual([expect.objectContaining({ app_name: 'web' })]);
    expect(JSON.stringify(result.pendingAction)).not.toContain(updateKey);
    expect(result.confirmationMessage).toContain('An update of "updating" is unresolved');
  });

  it('rejects a single unresolved update before constructing a restart confirmation', async () => {
    vi.mocked(getPendingMaintenanceOperation).mockReturnValue(pending('update'));
    const result = await executeRestartApp({ app_name: 'web' }, options([app('web', 1)]));
    expect(result.error).toContain('An update of "web" is unresolved');
    expect(result.pendingAction).toBeUndefined();
  });

  it('recovers only the active pending items of restart all using their exact keys', async () => {
    vi.mocked(getPendingMaintenanceOperation).mockImplementation((_address, _provider, lease) => lease === leaseUuid(1) ? pending('restart') : undefined);
    const result = await executeRestartApp({ app_name: 'all' }, options([
      app('pending', 1, { provisionState: 'unconfirmed', status: 'deploying' }), app('completed', 2),
    ]));
    expect(result.pendingAction?.args.entries).toEqual([expect.objectContaining({ app_name: 'pending', idempotencyKey: restartKey, expectPending: true })]);
    expect(result.confirmationMessage).toContain('Recover pending restarts');
  });

  it('omits historical stopped apps from restart all while naming an actual update conflict', async () => {
    vi.mocked(getPendingMaintenanceOperation).mockImplementation((_address, _provider, lease) => lease === leaseUuid(3) ? pending('update') : undefined);
    const result = await executeRestartApp({ app_name: 'all' }, options([
      app('closed', 1, { chainState: 'absent', status: 'stopped' }),
      app('legacy-stopped', 2, { chainState: undefined, status: 'stopped' }),
      app('updating', 3), app('web', 4),
    ]));
    expect(result.confirmationMessage).not.toContain('closed');
    expect(result.confirmationMessage).not.toContain('legacy-stopped');
    expect(result.confirmationMessage).toContain('An update of "updating" is unresolved');
  });

  it.each(['web', 'all'])('passes the pending-recovery requirement from %s confirmation to execution', async (app_name) => {
    vi.mocked(getPendingMaintenanceOperation).mockReturnValue(pending('restart'));
    const executionOptions = { ...options([app('web', 1)]), signing: {} as NonNullable<ToolExecutorOptions['signing']> };
    const confirmation = await executeRestartApp({ app_name }, executionOptions);
    expect(confirmation.requiresConfirmation).toBe(true);
    vi.mocked(executeMaintenance).mockResolvedValue({ outcome: 'succeeded', result: { success: true, data: {} } });

    await executeConfirmedRestartApp(confirmation.pendingAction!.args, {} as NonNullable<ToolExecutorOptions['clientManager']>, executionOptions);

    expect(executeMaintenance).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'restart', idempotencyKey: restartKey, expectPending: true,
    }), expect.anything());
  });

  it('keeps fresh batch items distinct from pending recovery entries', async () => {
    vi.mocked(getPendingMaintenanceOperation).mockImplementation((_address, _provider, lease) => lease === leaseUuid(1) ? pending('restart') : undefined);
    const result = await executeRestartApp({ app_name: 'pending,fresh' }, options([app('pending', 1), app('fresh', 2)]));
    const entries = result.pendingAction!.args.entries as Array<{ expectPending?: boolean }>;
    expect(entries[0].expectPending).toBe(true);
    expect(entries[1]).not.toHaveProperty('expectPending');
  });

  it('shows a cancelled PR240 item as terminal and retains the cancellation reason', async () => {
    const executionOptions = { ...options([app('web', 1)]), signing: {} as NonNullable<ToolExecutorOptions['signing']>, onProgress: vi.fn() };
    const confirmation = await executeRestartApp({ app_name: 'all' }, executionOptions);
    vi.mocked(executeMaintenance).mockResolvedValue({ outcome: 'cancelled', result: { success: false, error: 'Restart cancelled before dispatch.' } });

    const result = await executeConfirmedRestartApp(confirmation.pendingAction!.args, {} as NonNullable<ToolExecutorOptions['clientManager']>, executionOptions);

    expect(result.error).toContain('Cancelled: web');
    expect(executionOptions.onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'failed', batch: [
      expect.objectContaining({ name: 'web', phase: 'failed', detail: 'Restart cancelled before dispatch.' }),
    ] }));
  });

  it('preserves an actionable maintenance preparation failure in the batch tool response', async () => {
    const executionOptions = { ...options([app('web', 1)]), signing: {} as NonNullable<ToolExecutorOptions['signing']> };
    const confirmation = await executeRestartApp({ app_name: 'all' }, executionOptions);
    vi.mocked(executeMaintenance).mockResolvedValue({ outcome: 'failed', result: {
      success: false, error: 'Another command is in progress (release v7 is deploying). Wait and check app_releases and app_status before retrying.',
    } });

    const result = await executeConfirmedRestartApp(confirmation.pendingAction!.args, {} as NonNullable<ToolExecutorOptions['clientManager']>, executionOptions);

    expect(result.error).toContain('web: Another command is in progress (release v7 is deploying)');
    expect(result.error).toContain('app_releases and app_status');
  });
});
