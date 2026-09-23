import { runtimeConfig } from '../../config/runtimeConfig';
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

// sessionStorage belongs to this tab and survives reload. Another tab's
// deliberate successor must not erase recovery advice still visible here.
const memory = new Map<string, { intent: MaintenanceRecoveryIntent; persisted: boolean }>();
const neverSent = new Map<string, string>();
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
  if (retained && !retained.persisted && neverSent.get(key) !== retained.intent.idempotencyKey) return retained.intent;
  let raw: string | null | undefined;
  try {
    if (!storage) throw new Error('Session storage unavailable');
    raw = storage.getItem(key);
  } catch {
    if (retained && neverSent.get(key) !== retained.intent.idempotencyKey) return retained.intent;
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
    return neverSent.get(key) === intent.idempotencyKey ? undefined : intent;
  } catch {
    throw new Error('This tab’s saved recovery intent is unreadable. Restore browser storage access before starting another maintenance command.');
  }
}

export function rememberMaintenanceRecoveryIntent(command: RecoveryScope & MaintenanceRecoveryIntent, preserveExisting = false): void {
  const key = keyFor(command);
  if (neverSent.get(key) === command.idempotencyKey) return;
  const intent = Object.freeze({ operation: command.operation, idempotencyKey: command.idempotencyKey });
  if (preserveExisting) {
    try { if (getMaintenanceRecoveryIntent(command)) return; } catch {
      // Preserve unreadable storage; this known command still needs an in-memory
      // guard and transcript correlation while access is unavailable.
      const retained = memory.get(key);
      if (!retained || neverSent.get(key) === retained.intent.idempotencyKey) memory.set(key, { intent, persisted: false });
      return;
    }
  }
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

/** Only an authoritative never-sent receipt may discard an exact stale intent. */
export function retireUnsentMaintenanceRecoveryIntent(scope: RecoveryScope, idempotencyKey: string): void {
  const key = keyFor(scope);
  neverSent.set(key, idempotencyKey);
  const retained = memory.get(key);
  let stored: Partial<MaintenanceRecoveryIntent> | undefined;
  try { stored = JSON.parse(storage?.getItem(key) ?? 'null') ?? undefined; } catch { return; }
  if (retained?.intent.idempotencyKey !== idempotencyKey && stored?.idempotencyKey !== idempotencyKey) return;
  if (retained && retained.intent.idempotencyKey !== idempotencyKey) return;
  if (stored && stored.idempotencyKey !== idempotencyKey) return;
  memory.delete(key);
  try { storage?.removeItem(key); } catch { /* The matching authoritative tombstone is sufficient. */ }
}

function activeAdvice(identity: WalletIdentity): MaintenanceRecoveryAdvice[] {
  const advice: MaintenanceRecoveryAdvice[] = [];
  for (const [key, value] of memory) {
    if (neverSent.get(key) === value.intent.idempotencyKey) continue;
    const [chainId, rpcUrl, restUrl, address, providerUrl, leaseUuid] = JSON.parse(decodeURIComponent(key.slice('barney:maintenance:recovery-intent:'.length))) as string[];
    if (chainId !== identity.chainId || address !== identity.address) continue;
    advice.push({ ...value.intent, chainId, rpcUrl, restUrl, address, providerUrl, leaseUuid });
  }
  return advice;
}

/** Advice stays attached to the rows that can be replayed, even after a local
 * deliberate successor consumes the active guard. No manifest bytes are kept. */
export function retainMessageMaintenanceAdvice(messages: ChatMessage[], identity: WalletIdentity): ChatMessage[] {
  const advice = activeAdvice(identity);
  if (!advice.length) return messages;
  let changed = false;
  const result = messages.map((message) => {
    if (message.role === 'user' || message.local || message.isStreaming || message.awaitingConfirmation || message.transactionInFlight) return message;
    const retained = message.maintenanceRecoveryAdvice ?? [];
    const additions = advice.filter((entry) => !retained.some((prior) => prior.rpcUrl === entry.rpcUrl
      && prior.restUrl === entry.restUrl && keyFor(prior) === keyFor(entry)));
    if (!additions.length) return message;
    changed = true;
    return { ...message, maintenanceRecoveryAdvice: [...retained, ...additions] };
  });
  return changed ? result : messages;
}

export function restoreMessageMaintenanceAdvice(
  messages: ChatMessage[],
  identity: WalletIdentity,
  prepareScope?: (advice: MaintenanceRecoveryAdvice) => void,
): void {
  const applicable: MaintenanceRecoveryAdvice[] = [];
  const prepared = new Set<string>();
  for (const message of messages) {
    for (const advice of message.maintenanceRecoveryAdvice ?? []) {
      if (advice.chainId !== identity.chainId || advice.address !== identity.address
        || advice.rpcUrl !== runtimeConfig.PUBLIC_RPC_URL || advice.restUrl !== runtimeConfig.PUBLIC_REST_URL) continue;
      applicable.push(advice);
      const key = keyFor(advice);
      if (prepared.has(key)) continue;
      prepared.add(key);
      // Learn authoritative never-sent proof before any later row can replace
      // an older sent command's still-visible recovery advice.
      try { prepareScope?.(advice); } catch { /* Unreadable proof cannot retire any advice. */ }
    }
  }
  const restored = new Set<string>();
  for (const advice of applicable) {
    const key = keyFor(advice);
    if (restored.has(key) || neverSent.get(key) === advice.idempotencyKey) continue;
    // Keep the oldest actionable row. If proof was temporarily unreadable,
    // retiring a newer never-sent command later still cannot erase this guard.
    rememberMaintenanceRecoveryIntent(advice);
    restored.add(key);
  }
}
