import { afterEach, describe, expect, it } from 'vitest';
import { canPlanMaintenanceCompletions, captureMaintenanceCompletionEpoch, clearCompletedMaintenance, getCompletedMaintenance, isMaintenanceCompletionCacheFull, isMaintenanceCompletionEpochCurrent, MAX_COMPLETED_MAINTENANCE, releaseAbsentMaintenanceCompletions, releaseMaintenanceCompletionReservation, rememberMaintenanceCompletion, reserveMaintenanceCompletions } from './maintenanceCompletion';
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

  it('reserves an entire batch synchronously, includes pending work in admission, and rolls back no slots on refusal', () => {
    const epoch = captureMaintenanceCompletionEpoch(command);
    for (let i = 0; i < MAX_COMPLETED_MAINTENANCE - 1; i++) {
      rememberMaintenanceCompletion({ ...command, idempotencyKey: crypto.randomUUID() }, result, epoch);
    }
    const batch = Array.from({ length: 8 }, () => ({ ...command, idempotencyKey: crypto.randomUUID() }));
    expect(reserveMaintenanceCompletions(batch, epoch)).toBeUndefined();
    expect(canPlanMaintenanceCompletions(command, 1)).toBe(true);
    const single = reserveMaintenanceCompletions([batch[0]], epoch)!;
    expect(isMaintenanceCompletionCacheFull(command)).toBe(true);
    expect(reserveMaintenanceCompletions([batch[1]], epoch)).toBeUndefined();
    releaseMaintenanceCompletionReservation(single);
    expect(canPlanMaintenanceCompletions(command, 1)).toBe(true);
  });

  it('shares batch admission with executing items without releasing another owner or unresolved dispatch', () => {
    const epoch = captureMaintenanceCompletionEpoch(command);
    const batch = Array.from({ length: MAX_COMPLETED_MAINTENANCE }, () => ({ ...command, idempotencyKey: crypto.randomUUID() }));
    const outer = reserveMaintenanceCompletions(batch, epoch)!;
    const inner = reserveMaintenanceCompletions([batch[0]], epoch)!;
    releaseMaintenanceCompletionReservation(outer);
    expect(canPlanMaintenanceCompletions(command, MAX_COMPLETED_MAINTENANCE)).toBe(false);
    releaseMaintenanceCompletionReservation(inner, true);
    expect(canPlanMaintenanceCompletions(command, MAX_COMPLETED_MAINTENANCE)).toBe(false);
    expect(rememberMaintenanceCompletion(batch[0], result, epoch)).toBe(true);
    expect(canPlanMaintenanceCompletions(command, MAX_COMPLETED_MAINTENANCE - 1)).toBe(true);
    expect(getCompletedMaintenance(batch[0])).toEqual({ payloadHash: command.payloadHash, result });
  });

  it('preserves completed replays and pending recoveries at the capacity limit', () => {
    const epoch = captureMaintenanceCompletionEpoch(command);
    for (let i = 0; i < MAX_COMPLETED_MAINTENANCE; i++) {
      rememberMaintenanceCompletion({ ...command, idempotencyKey: i === 0 ? command.idempotencyKey : crypto.randomUUID() }, result, epoch);
    }
    const replay = reserveMaintenanceCompletions([command], epoch);
    const recovery = reserveMaintenanceCompletions([{ ...command, idempotencyKey: crypto.randomUUID(), recovery: true }], epoch);
    expect(replay).toBeDefined();
    expect(recovery).toBeDefined();
    expect(getCompletedMaintenance(command)).toEqual({ payloadHash: command.payloadHash, result });
    expect(isMaintenanceCompletionCacheFull(command)).toBe(true);
  });

  it('releases only the closed lease reservation while preserving other scopes and completed results', () => {
    const otherLease = { ...command, leaseUuid: crypto.randomUUID() };
    for (const retained of [command, otherLease, otherWallet, otherChain]) {
      const epoch = captureMaintenanceCompletionEpoch(retained);
      const reservation = reserveMaintenanceCompletions([retained], epoch)!;
      releaseMaintenanceCompletionReservation(reservation, true);
    }
    const epoch = captureMaintenanceCompletionEpoch(command);
    const completed = { ...command, idempotencyKey: crypto.randomUUID() };
    rememberMaintenanceCompletion(completed, result, epoch);
    releaseAbsentMaintenanceCompletions(command);
    expect(canPlanMaintenanceCompletions(command, MAX_COMPLETED_MAINTENANCE - 2)).toBe(true);
    expect(canPlanMaintenanceCompletions(command, MAX_COMPLETED_MAINTENANCE - 1)).toBe(false);
    expect(canPlanMaintenanceCompletions(otherWallet, MAX_COMPLETED_MAINTENANCE)).toBe(false);
    expect(canPlanMaintenanceCompletions(otherChain, MAX_COMPLETED_MAINTENANCE)).toBe(false);
    expect(getCompletedMaintenance(completed)).toEqual({ payloadHash: command.payloadHash, result });
  });

  it('does not let unrelated completion writes consume slots reserved for an approved batch', () => {
    const epoch = captureMaintenanceCompletionEpoch(command);
    const batch = Array.from({ length: MAX_COMPLETED_MAINTENANCE }, () => ({ ...command, idempotencyKey: crypto.randomUUID() }));
    const reservation = reserveMaintenanceCompletions(batch, epoch)!;
    expect(rememberMaintenanceCompletion(command, result, epoch)).toBe(false);
    for (const item of batch) expect(rememberMaintenanceCompletion(item, result, epoch)).toBe(true);
    releaseMaintenanceCompletionReservation(reservation);
    expect(getCompletedMaintenance(batch.at(-1)!)).toEqual({ payloadHash: command.payloadHash, result });
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
