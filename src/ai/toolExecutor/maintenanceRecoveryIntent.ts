import { runtimeConfig } from '../../config/runtimeConfig';
import { MAINTENANCE_NEVER_SENT_PROOF_LIMIT, MAINTENANCE_CONSUMED_ADVICE_LIMIT } from '../../config/constants';
import type { WalletIdentity } from '../../utils/walletIdentity';
import type { ChatMessage } from '../../contexts/aiTypes';

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
export interface MaintenanceRecoveryAdvice extends MaintenanceRecoveryIntent, Required<RecoveryScope> {
  readonly rpcUrl: string;
  readonly restUrl: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const memory = new Map<string, { intent: MaintenanceRecoveryIntent; persisted: boolean }>();
const consumed = new Map<string, Set<string>>();
const observed = new Map<string, Map<string, MaintenanceRecoveryIntent['operation']>>();
const neverSent = new Map<string, Set<string>>();
class SessionStorageUnavailable extends Error {}
let storage: Storage | undefined;
try { storage = globalThis.sessionStorage; } catch { /* Memory remains available. */ }

function keyFor(scope: RecoveryScope): string {
  return `barney:maintenance:recovery-intent:${encodeURIComponent(JSON.stringify([
    scope.chainId ?? runtimeConfig.PUBLIC_CHAIN_ID, runtimeConfig.PUBLIC_RPC_URL, runtimeConfig.PUBLIC_REST_URL,
    scope.address.trim().toLowerCase(), new URL(scope.providerUrl).href.replace(/\/+$/, ''), scope.leaseUuid,
  ]))}`;
}

function bounded(keys: Iterable<string>): Set<string> {
  const result = new Set(keys);
  while (result.size > MAINTENANCE_CONSUMED_ADVICE_LIMIT) result.delete(result.values().next().value!);
  return result;
}

function observe(key: string, intent: MaintenanceRecoveryIntent): void {
  if (suppressed(key, intent.idempotencyKey)) return;
  const seen = observed.get(key) ?? new Map();
  seen.set(intent.idempotencyKey, intent.operation);
  while (seen.size > MAINTENANCE_CONSUMED_ADVICE_LIMIT) seen.delete(seen.keys().next().value!);
  observed.set(key, seen);
}

function fallbackIntent(key: string): MaintenanceRecoveryIntent | undefined {
  for (const [idempotencyKey, operation] of observed.get(key) ?? []) {
    if (!suppressed(key, idempotencyKey)) return Object.freeze({ operation, idempotencyKey });
  }
}

function actionable(key: string, intent: MaintenanceRecoveryIntent | undefined): MaintenanceRecoveryIntent | undefined {
  return intent && !suppressed(key, intent.idempotencyKey) ? intent : fallbackIntent(key);
}

function suppressed(key: string, idempotencyKey: string): boolean {
  return neverSent.get(key)?.has(idempotencyKey) === true || consumed.get(key)?.has(idempotencyKey) === true;
}

/** Legacy entries contain only the active identity. New entries retain consumed
 * UUIDs in the same slot; consumption removes more bytes than it appends. */
function readStored(key: string): MaintenanceRecoveryIntent | undefined {
  if (!storage) throw new SessionStorageUnavailable('Session storage unavailable');
  let raw;
  try { raw = storage.getItem(key); } catch { throw new SessionStorageUnavailable('Session storage unavailable'); }
  if (raw === null) { consumed.delete(key); return undefined; }
  const value = JSON.parse(raw) as Partial<MaintenanceRecoveryIntent> & { c?: unknown; h?: unknown };
  if (!value || typeof value !== 'object'
    || Object.keys(value).some((field) => !['operation', 'idempotencyKey', 'c', 'h'].includes(field))) throw new Error('Invalid session entry');
  if (value.c !== undefined && (!Array.isArray(value.c) || value.c.length > MAINTENANCE_CONSUMED_ADVICE_LIMIT
    || value.c.some((id) => typeof id !== 'string' || !UUID_V4.test(id)))) throw new Error('Invalid consumed identities');
  if (value.h !== undefined && (!Array.isArray(value.h) || value.h.length > MAINTENANCE_CONSUMED_ADVICE_LIMIT
    || value.h.some((item) => !Array.isArray(item) || item.length !== 2 || (item[0] !== 'restart' && item[0] !== 'update')
      || typeof item[1] !== 'string' || !UUID_V4.test(item[1])))) throw new Error('Invalid observed identities');
  const used = new Set((value.c ?? []) as string[]);
  let intent: MaintenanceRecoveryIntent | undefined;
  if (value.operation !== undefined || value.idempotencyKey !== undefined) {
    if ((value.operation !== 'restart' && value.operation !== 'update')
      || typeof value.idempotencyKey !== 'string' || !UUID_V4.test(value.idempotencyKey)) throw new Error('Invalid active identity');
    intent = Object.freeze({ operation: value.operation, idempotencyKey: value.idempotencyKey });
  } else if (!used.size && !(value.h as unknown[] | undefined)?.length) throw new Error('Empty session entry');
  consumed.set(key, used);
  for (const id of observed.get(key)?.keys() ?? []) if (suppressed(key, id)) observed.get(key)?.delete(id);
  for (const [operation, idempotencyKey] of (value.h ?? []) as Array<[MaintenanceRecoveryIntent['operation'], string]>) {
    observe(key, { operation, idempotencyKey });
  }
  if (intent) observe(key, intent);
  return intent;
}

function serialized(key: string, intent?: MaintenanceRecoveryIntent, used = consumed.get(key), seen = observed.get(key)): string {
  const prior = [...(seen ?? [])].filter(([id]) => id !== intent?.idempotencyKey && !suppressed(key, id))
    .map(([id, operation]) => [operation, id]);
  return JSON.stringify({ ...intent, ...(used?.size && { c: [...used] }), ...(prior.length && { h: prior }) });
}

export function getMaintenanceRecoveryIntent(scope: RecoveryScope): MaintenanceRecoveryIntent | undefined {
  const key = keyFor(scope);
  const retained = memory.get(key);
  if (retained && !retained.persisted && !suppressed(key, retained.intent.idempotencyKey)) return retained.intent;
  let intent;
  try { intent = readStored(key); } catch (error) {
    if (error instanceof SessionStorageUnavailable && retained && !suppressed(key, retained.intent.idempotencyKey)) return retained.intent;
    throw new Error('This tab’s saved recovery intent could not be read or is unreadable. Restore browser storage access before starting another maintenance command.');
  }
  const selected = actionable(key, intent);
  if (!selected) { memory.delete(key); return undefined; }
  memory.set(key, { intent: selected, persisted: selected === intent });
  return selected;
}

export function rememberMaintenanceRecoveryIntent(command: RecoveryScope & MaintenanceRecoveryIntent, preserveExisting = false): void {
  const key = keyFor(command);
  const intent = Object.freeze({ operation: command.operation, idempotencyKey: command.idempotencyKey });
  let selected = intent;
  try {
    // Recheck storage before any write, even when a quota failure left newer
    // memory evidence. Unknown persisted advice must remain untouched.
    const stored = readStored(key);
    const retained = memory.get(key);
    const existing = retained && !retained.persisted && !suppressed(key, retained.intent.idempotencyKey)
      ? retained.intent : actionable(key, stored);
    if (suppressed(key, command.idempotencyKey)) return;
    observe(key, intent);
    if (preserveExisting && existing) selected = existing;
  } catch {
    const retained = memory.get(key);
    observe(key, intent);
    if (!suppressed(key, command.idempotencyKey)
      && (!preserveExisting || !retained || suppressed(key, retained.intent.idempotencyKey))) memory.set(key, { intent, persisted: false });
    return; // Never overwrite unreadable prior evidence.
  }
  memory.set(key, { intent: selected, persisted: false });
  try {
    if (storage) { storage.setItem(key, serialized(key, selected)); memory.set(key, { intent: selected, persisted: true }); }
  } catch { /* Never lose in-memory evidence on quota failure. */ }
}

/** Exact deliberate dispatch acknowledges advice already observed in this tab,
 * including after reload. Other tabs retain their independent source advice. */
export function consumeMaintenanceRecoveryIntent(scope: RecoveryScope, expectedKey: string | undefined): void {
  if (!expectedKey || getMaintenanceRecoveryIntent(scope)?.idempotencyKey !== expectedKey) return;
  const key = keyFor(scope);
  try {
    // A memory fallback cannot authorize overwriting unreadable or newer disk
    // evidence if storage changes between advice and the HTTP handoff.
    const stored = readStored(key);
    if (stored && stored.idempotencyKey !== expectedKey && !suppressed(key, stored.idempotencyKey)) return;
    if (!storage) return;
    const seen = [...(observed.get(key)?.keys() ?? []), expectedKey].filter((id) => !neverSent.get(key)?.has(id));
    const used = bounded([...(consumed.get(key) ?? []), ...seen]);
    storage.setItem(key, serialized(key, undefined, used, new Map()));
    consumed.set(key, used);
    observed.delete(key);
    memory.delete(key);
  } catch { /* Keep the active guard unless suppression is durable. */ }
}

export function retireMaintenanceRecoveryIntent(scope: RecoveryScope): void {
  const key = keyFor(scope);
  memory.delete(key);
  consumed.delete(key);
  observed.delete(key);
  try { storage?.removeItem(key); } catch { /* The closed lease cannot execute more maintenance. */ }
}

export function isMaintenanceAdviceNeverSent(advice: RecoveryScope & MaintenanceRecoveryIntent): boolean {
  return neverSent.get(keyFor(advice))?.has(advice.idempotencyKey) === true;
}

/** Exact proof cannot erase unreadable or newer session evidence. */
export function retireUnsentMaintenanceRecoveryIntent(scope: RecoveryScope, idempotencyKey: string): void {
  const key = keyFor(scope);
  const keys = neverSent.get(key) ?? new Set<string>();
  keys.add(idempotencyKey);
  while (keys.size > MAINTENANCE_NEVER_SENT_PROOF_LIMIT) keys.delete(keys.values().next().value!);
  neverSent.set(key, keys);
  const retained = memory.get(key);
  let stored;
  try { stored = readStored(key); } catch { return; }
  if (retained?.intent.idempotencyKey !== idempotencyKey && stored?.idempotencyKey !== idempotencyKey) return;
  if (retained && retained.intent.idempotencyKey !== idempotencyKey) return;
  if (stored && stored.idempotencyKey !== idempotencyKey) return;
  const next = fallbackIntent(key);
  if (next) memory.set(key, { intent: next, persisted: false });
  else memory.delete(key);
  try {
    if (next || consumed.get(key)?.size) storage?.setItem(key, serialized(key, next));
    else storage?.removeItem(key);
    if (next && storage) memory.set(key, { intent: next, persisted: true });
  } catch { /* The exact proof and any promoted guard remain available in memory. */ }
}

export function syncMaintenanceNeverSentProofs(scope: RecoveryScope, keys: readonly string[]): void {
  neverSent.set(keyFor(scope), new Set(keys));
  for (const key of keys) retireUnsentMaintenanceRecoveryIntent(scope, key);
}

export function maintenanceRecoveryAdvice(command: RecoveryScope & MaintenanceRecoveryIntent): MaintenanceRecoveryAdvice {
  return { operation: command.operation, idempotencyKey: command.idempotencyKey,
    address: command.address.trim().toLowerCase(), chainId: command.chainId ?? runtimeConfig.PUBLIC_CHAIN_ID,
    providerUrl: new URL(command.providerUrl).href.replace(/\/+$/, ''), leaseUuid: command.leaseUuid,
    rpcUrl: runtimeConfig.PUBLIC_RPC_URL, restUrl: runtimeConfig.PUBLIC_REST_URL };
}

function adviceKey(advice: MaintenanceRecoveryAdvice): string {
  return JSON.stringify([advice.chainId, advice.rpcUrl, advice.restUrl, advice.address, advice.providerUrl, advice.leaseUuid, advice.idempotencyKey]);
}

export function mergeMaintenanceAdvice(existing: readonly MaintenanceRecoveryAdvice[] = [], incoming: readonly MaintenanceRecoveryAdvice[] = []): MaintenanceRecoveryAdvice[] {
  const keys = new Set(existing.map(adviceKey));
  const merged = [...existing];
  for (const advice of incoming) {
    const key = adviceKey(advice);
    if (!keys.has(key)) { keys.add(key); merged.push(advice); }
  }
  return merged;
}

/** A collector belongs to one executor invocation, including its batch items. */
export function createMaintenanceAdviceCollector() {
  const advice = new Map<string, MaintenanceRecoveryAdvice>();
  return {
    onAdvice(value: MaintenanceRecoveryAdvice) {
      rememberMaintenanceRecoveryIntent(value, true);
      advice.set(adviceKey(value), value);
    },
    get advice(): MaintenanceRecoveryAdvice[] { return [...advice.values()]; },
  };
}

export function restoreMessageMaintenanceAdvice(messages: ChatMessage[], identity: WalletIdentity, prepareScope?: (advice: MaintenanceRecoveryAdvice) => void): void {
  const applicable: Array<{ advice: MaintenanceRecoveryAdvice; key: string }> = [];
  const prepared = new Set<string>();
  for (const message of messages) {
    for (const advice of message.maintenanceRecoveryAdvice ?? []) {
      if (advice.chainId !== identity.chainId || advice.address !== identity.address
        || advice.rpcUrl !== runtimeConfig.PUBLIC_RPC_URL || advice.restUrl !== runtimeConfig.PUBLIC_REST_URL) continue;
      const key = keyFor(advice);
      applicable.push({ advice, key });
      if (prepared.has(key)) continue;
      prepared.add(key);
      try { prepareScope?.(advice); } catch { /* Unreadable proof cannot retire advice. */ }
      try { getMaintenanceRecoveryIntent(advice); } catch { /* Restore known advice conservatively. */ }
    }
  }
  const restored = new Set<string>();
  for (const { advice, key } of applicable) {
    if (suppressed(key, advice.idempotencyKey)) continue;
    rememberMaintenanceRecoveryIntent(advice, restored.has(key));
    restored.add(key);
  }
}
