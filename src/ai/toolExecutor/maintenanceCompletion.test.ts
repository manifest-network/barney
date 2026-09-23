import { afterEach, describe, expect, it } from 'vitest';
import { captureMaintenanceCompletionEpoch, clearCompletedMaintenance, getCompletedMaintenance, isMaintenanceCompletionCacheFull, isMaintenanceCompletionEpochCurrent, MAX_COMPLETED_MAINTENANCE, rememberMaintenanceCompletion } from './maintenanceCompletion';
import type { MaintenanceOperation } from './maintenanceOperation';

const command: MaintenanceOperation = {
  address: 'manifest1alice', chainId: 'chain-a', providerUrl: 'https://provider.example',
  leaseUuid: '550e8400-e29b-41d4-a716-446655440000', operation: 'update',
  idempotencyKey: '11111111-1111-4111-8111-111111111111', payloadHash: 'a'.repeat(64), baselineReleaseVersions: [1],
  manifest: '{"image":"nginx","env":{"PASSWORD":"private-secret"}}',
};
const otherWallet = { ...command, address: 'manifest1bob' };
const otherChain = { ...command, chainId: 'chain-b' };
const result = { outcome: 'succeeded' as const, result: { success: true as const, data: { status: 'running' } } };

afterEach(() => {
  for (const scope of [command, otherWallet, otherChain]) clearCompletedMaintenance(scope);
});

describe('maintenance completion lifecycle', () => {
  it('retains only the command fingerprint and public result', () => {
    rememberMaintenanceCompletion(command, result, captureMaintenanceCompletionEpoch(command));
    expect(getCompletedMaintenance(command)).toEqual({ payloadHash: command.payloadHash, result });
    expect(JSON.stringify(getCompletedMaintenance(command))).not.toContain('private-secret');
  });

  it('caps exact results without evicting keys needed by repeated confirmations', () => {
    const epoch = captureMaintenanceCompletionEpoch(command);
    const commands = Array.from({ length: MAX_COMPLETED_MAINTENANCE + 1 }, () => ({ ...command, idempotencyKey: crypto.randomUUID() }));
    for (const retained of commands.slice(0, MAX_COMPLETED_MAINTENANCE)) {
      expect(rememberMaintenanceCompletion(retained, result, epoch)).toBe(true);
    }
    expect(isMaintenanceCompletionCacheFull(command)).toBe(true);
    expect(rememberMaintenanceCompletion(commands.at(-1)!, result, epoch)).toBe(false);
    expect(commands.filter((retained) => getCompletedMaintenance(retained))).toHaveLength(MAX_COMPLETED_MAINTENANCE);
    expect(getCompletedMaintenance(commands[0])).toEqual({ payloadHash: command.payloadHash, result });
    expect(getCompletedMaintenance(commands.at(-1)!)).toBeUndefined();
    clearCompletedMaintenance(command);
    expect(isMaintenanceCompletionCacheFull(command)).toBe(false);
  });

  it('rejects late writes after invalidation, including after the same wallet starts a new session', () => {
    const staleEpoch = captureMaintenanceCompletionEpoch(command);
    clearCompletedMaintenance(command);
    expect(isMaintenanceCompletionEpochCurrent(staleEpoch)).toBe(false);
    expect(rememberMaintenanceCompletion(command, result, staleEpoch)).toBe(false);
    const currentEpoch = captureMaintenanceCompletionEpoch(command);
    expect(rememberMaintenanceCompletion(command, result, staleEpoch)).toBe(false);
    expect(getCompletedMaintenance(command)).toBeUndefined();
    expect(rememberMaintenanceCompletion(command, result, currentEpoch)).toBe(true);
    expect(isMaintenanceCompletionEpochCurrent(currentEpoch)).toBe(true);
  });

  it('does not let one wallet epoch write into another wallet cache', () => {
    const epoch = captureMaintenanceCompletionEpoch(command);
    captureMaintenanceCompletionEpoch(otherWallet);
    expect(rememberMaintenanceCompletion(otherWallet, result, epoch)).toBe(false);
  });

  it('clears the invalidated wallet scope without touching another wallet or chain', () => {
    for (const scope of [command, otherWallet, otherChain]) rememberMaintenanceCompletion(scope, result, captureMaintenanceCompletionEpoch(scope));
    clearCompletedMaintenance({ address: ' MANIFEST1ALICE ', chainId: command.chainId });
    expect(getCompletedMaintenance(command)).toBeUndefined();
    expect(getCompletedMaintenance(otherWallet)).toEqual({ payloadHash: command.payloadHash, result });
    expect(getCompletedMaintenance(otherChain)).toEqual({ payloadHash: command.payloadHash, result });
  });
});
