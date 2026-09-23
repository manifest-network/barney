import { runtimeConfig } from '../../config/runtimeConfig';
import type { MaintenanceOperation } from './maintenanceOperation';
import type { ToolResult } from './types';

export type MaintenanceResult = {
  outcome: 'succeeded' | 'failed' | 'unconfirmed' | 'cancelled';
  result: ToolResult;
  url?: string;
};

type CommandIdentity = Pick<MaintenanceOperation, 'address' | 'providerUrl' | 'leaseUuid' | 'operation' | 'idempotencyKey' | 'chainId'>;
type CompletionScope = Pick<CommandIdentity, 'address' | 'chainId'>;

/** A session boundary invalidates this token even when the same wallet reconnects. */
export interface MaintenanceCompletionEpoch {
  readonly scopeKey: string;
  readonly generation: symbol;
}

/** No eviction: losing a prior key would allow its replay against a fresh baseline. */
export const MAX_COMPLETED_MAINTENANCE = 128;
interface CompletionSession {
  readonly epoch: MaintenanceCompletionEpoch;
  readonly results: Map<string, { result: MaintenanceResult; payloadHash: string }>;
}
const sessions = new Map<string, CompletionSession>();

function scopeKey(scope: CompletionScope): string {
  return JSON.stringify([scope.chainId, runtimeConfig.PUBLIC_RPC_URL, runtimeConfig.PUBLIC_REST_URL, scope.address.trim().toLowerCase()]);
}

function completionKey(command: CommandIdentity): string {
  return JSON.stringify([
    new URL(command.providerUrl).href.replace(/\/+$/, ''), command.leaseUuid, command.operation, command.idempotencyKey,
  ]);
}

/** Capture before awaiting work; a late callback must not create a new session. */
export function captureMaintenanceCompletionEpoch(scope: CompletionScope): MaintenanceCompletionEpoch {
  const key = scopeKey(scope);
  let session = sessions.get(key);
  if (!session) {
    session = { epoch: Object.freeze({ scopeKey: key, generation: Symbol('maintenance session') }), results: new Map() };
    sessions.set(key, session);
  }
  return session.epoch;
}

export function isMaintenanceCompletionEpochCurrent(epoch: MaintenanceCompletionEpoch): boolean {
  return sessions.get(epoch.scopeKey)?.epoch === epoch;
}

export function getCompletedMaintenance(command: CommandIdentity) {
  return sessions.get(scopeKey(command))?.results.get(completionKey(command));
}

/** Unknown keys need a new session once the exact result cache reaches its limit. */
export function isMaintenanceCompletionCacheFull(scope: CompletionScope): boolean {
  return (sessions.get(scopeKey(scope))?.results.size ?? 0) >= MAX_COMPLETED_MAINTENANCE;
}

export function rememberMaintenanceCompletion(
  command: MaintenanceOperation,
  result: MaintenanceResult,
  epoch: MaintenanceCompletionEpoch,
): boolean {
  const session = sessions.get(scopeKey(command));
  if (!session || session.epoch !== epoch) return false;
  const key = completionKey(command);
  const prior = session.results.get(key);
  if (prior) return prior.payloadHash === command.payloadHash;
  if (session.results.size >= MAX_COMPLETED_MAINTENANCE) return false;
  // Retain only the fingerprint and public result, never command/manifest bytes.
  session.results.set(key, { result, payloadHash: command.payloadHash });
  return true;
}

/** Call only after invalidating the owning wallet's approved confirmations. */
export function clearCompletedMaintenance(scope: CompletionScope): void {
  sessions.delete(scopeKey(scope));
}
