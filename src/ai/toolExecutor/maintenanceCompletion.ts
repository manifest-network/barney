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
export const MAINTENANCE_CAPACITY_MESSAGE = 'This wallet has reached its maintenance confirmation limit. Clear its chat history before starting another command.';

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
  readonly reservations: Map<string, { owners: Set<symbol>; pending: boolean }>;
}
export interface MaintenanceCompletionReservation {
  readonly epoch: MaintenanceCompletionEpoch;
  readonly owner: symbol;
  readonly keys: readonly string[];
}
type ReservationCommand = CommandIdentity & { recovery?: boolean };
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
    session = { epoch: Object.freeze({ scopeKey: key, generation: Symbol('maintenance session') }), results: new Map(), reservations: new Map() };
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
  return !canPlanMaintenanceCompletions(scope, 1);
}

/** Planning never consumes a slot, but must not offer an impossible confirmation. */
export function canPlanMaintenanceCompletions(scope: CompletionScope, newCommands: number): boolean {
  const session = sessions.get(scopeKey(scope));
  return newCommands === 0 || (session?.results.size ?? 0) + (session?.reservations.size ?? 0) + newCommands <= MAX_COMPLETED_MAINTENANCE;
}

/** Synchronous admission reserves the entire batch before any provider work starts. */
export function reserveMaintenanceCompletions(
  commands: readonly ReservationCommand[],
  epoch: MaintenanceCompletionEpoch,
): MaintenanceCompletionReservation | undefined {
  const session = sessions.get(epoch.scopeKey);
  if (!session || session.epoch !== epoch || commands.some((command) => scopeKey(command) !== epoch.scopeKey)) return undefined;
  const unique = new Map(commands.map((command) => [completionKey(command), command]));
  const newKeys = [...unique].filter(([key, command]) => !command.recovery && !session.results.has(key) && !session.reservations.has(key));
  if (session.results.size + session.reservations.size + newKeys.length > MAX_COMPLETED_MAINTENANCE) return undefined;
  const owner = Symbol('maintenance reservation');
  const keys: string[] = [];
  // Reserve new work first. Existing pending commands may still be recovered
  // after reload at the limit; they never evict an older confirmation's result.
  for (const [key] of newKeys) session.reservations.set(key, { owners: new Set(), pending: false });
  for (const [key] of unique) {
    if (session.results.has(key)) continue;
    let reservation = session.reservations.get(key);
    if (!reservation && session.results.size + session.reservations.size < MAX_COMPLETED_MAINTENANCE) {
      reservation = { owners: new Set(), pending: false };
      session.reservations.set(key, reservation);
    }
    if (reservation) {
      reservation.owners.add(owner);
      keys.push(key);
    }
  }
  return { epoch, owner, keys };
}

/** Keep dispatched, unresolved keys admitted until their result is established. */
export function releaseMaintenanceCompletionReservation(
  reservation: MaintenanceCompletionReservation,
  retainPending = false,
): void {
  const session = sessions.get(reservation.epoch.scopeKey);
  if (session?.epoch !== reservation.epoch) return;
  for (const key of reservation.keys) {
    const slot = session.reservations.get(key);
    if (!slot) continue;
    slot.owners.delete(reservation.owner);
    slot.pending ||= retainPending;
    if (!slot.pending && slot.owners.size === 0) session.reservations.delete(key);
  }
}

/** A durable receipt observed from another tab also releases its unresolved slot. */
export function releaseSettledMaintenanceCompletion(command: CommandIdentity): void {
  sessions.get(scopeKey(command))?.reservations.delete(completionKey(command));
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
  if (session.results.size >= MAX_COMPLETED_MAINTENANCE
    || (!session.reservations.has(key) && session.results.size + session.reservations.size >= MAX_COMPLETED_MAINTENANCE)) return false;
  // Retain only the fingerprint and public result, never command/manifest bytes.
  session.results.set(key, { result, payloadHash: command.payloadHash });
  session.reservations.delete(key);
  return true;
}

/** Call only after invalidating the owning wallet's approved confirmations. */
export function clearCompletedMaintenance(scope: CompletionScope): void {
  sessions.delete(scopeKey(scope));
}
