import { runtimeConfig } from '../../config/runtimeConfig';

interface RecoveryScope {
  readonly address: string;
  readonly providerUrl: string;
  readonly leaseUuid: string;
  readonly chainId?: string;
}
export interface MaintenanceRecoveryIntent {
  readonly operation: 'restart' | 'update';
  readonly idempotencyKey: string;
}

// sessionStorage belongs to this tab and survives reload. Another tab's
// deliberate successor must not erase recovery advice still visible here.
const memory = new Map<string, { intent: MaintenanceRecoveryIntent; persisted: boolean }>();
let storage: Storage | undefined;
try { storage = globalThis.sessionStorage; } catch { /* Memory remains available. */ }

function keyFor(scope: RecoveryScope): string {
  return `barney:maintenance:recovery-intent:${encodeURIComponent(JSON.stringify([
    scope.chainId ?? runtimeConfig.PUBLIC_CHAIN_ID, runtimeConfig.PUBLIC_RPC_URL, runtimeConfig.PUBLIC_REST_URL,
    scope.address.trim().toLowerCase(), new URL(scope.providerUrl).href.replace(/\/+$/, ''), scope.leaseUuid,
  ]))}`;
}

export function getMaintenanceRecoveryIntent(scope: RecoveryScope): MaintenanceRecoveryIntent | undefined {
  const key = keyFor(scope);
  const retained = memory.get(key);
  if (retained && !retained.persisted) return retained.intent;
  let raw: string | null | undefined;
  try {
    if (!storage) throw new Error('Session storage unavailable');
    raw = storage.getItem(key);
  } catch {
    if (retained) return retained.intent;
    throw new Error('This tab’s saved recovery intent could not be read. Restore browser storage access before starting another maintenance command.');
  }
  if (!raw) { memory.delete(key); return undefined; }
  try {
    const value = JSON.parse(raw) as Partial<MaintenanceRecoveryIntent>;
    if ((value.operation !== 'restart' && value.operation !== 'update')
      || typeof value.idempotencyKey !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.idempotencyKey)) throw new Error();
    const intent = Object.freeze({ operation: value.operation, idempotencyKey: value.idempotencyKey });
    memory.set(key, { intent, persisted: true });
    return intent;
  } catch {
    throw new Error('This tab’s saved recovery intent is unreadable. Restore browser storage access before starting another maintenance command.');
  }
}

export function rememberMaintenanceRecoveryIntent(command: RecoveryScope & MaintenanceRecoveryIntent): void {
  const key = keyFor(command);
  const intent = Object.freeze({ operation: command.operation, idempotencyKey: command.idempotencyKey });
  memory.set(key, { intent, persisted: false });
  try {
    if (storage) { storage.setItem(key, JSON.stringify(intent)); memory.set(key, { intent, persisted: true }); }
  } catch { /* Never lose in-memory evidence on quota failure. */ }
}

/** Only dispatch of the approved deliberate successor consumes its own intent. */
export function consumeMaintenanceRecoveryIntent(scope: RecoveryScope, expectedKey: string | undefined): void {
  if (!expectedKey || getMaintenanceRecoveryIntent(scope)?.idempotencyKey !== expectedKey) return;
  const key = keyFor(scope);
  try { storage?.removeItem(key); } catch { return; }
  memory.delete(key);
}

export function retireMaintenanceRecoveryIntent(scope: RecoveryScope): void {
  const key = keyFor(scope);
  memory.delete(key);
  try { storage?.removeItem(key); } catch { /* An authoritative closed lease cannot execute more maintenance. */ }
}
