import { afterEach, describe, expect, it } from 'vitest';
import { clearCompletedMaintenance, getCompletedMaintenance, rememberMaintenanceCompletion } from './maintenanceCompletion';
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
    rememberMaintenanceCompletion(command, result);
    expect(getCompletedMaintenance(command)).toEqual({ payloadHash: command.payloadHash, result });
    expect(JSON.stringify(getCompletedMaintenance(command))).not.toContain('private-secret');
  });

  it('clears the invalidated wallet scope without touching another wallet or chain', () => {
    for (const scope of [command, otherWallet, otherChain]) rememberMaintenanceCompletion(scope, result);
    clearCompletedMaintenance({ address: ' MANIFEST1ALICE ', chainId: command.chainId });
    expect(getCompletedMaintenance(command)).toBeUndefined();
    expect(getCompletedMaintenance(otherWallet)).toEqual({ payloadHash: command.payloadHash, result });
    expect(getCompletedMaintenance(otherChain)).toEqual({ payloadHash: command.payloadHash, result });
  });
});
