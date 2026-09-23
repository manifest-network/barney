import { createMaintenanceIdempotencyKey, metaHashHex } from '@manifest-network/manifest-sdk/deploy';
import { runtimeConfig } from '../../config/runtimeConfig';
import { MAINTENANCE_NEVER_SENT_PROOF_LIMIT } from '../../config/constants';
import { logError } from '../../utils/errors';
import { releaseAbsentMaintenanceCompletions } from './maintenanceCompletion';
import { getMaintenanceRecoveryIntent, maintenanceRecoveryAdvice, rememberMaintenanceRecoveryIntent, retireMaintenanceRecoveryIntent, syncMaintenanceNeverSentProofs, type MaintenanceRecoveryAdvice } from './maintenanceRecoveryIntent';

type MaintenanceKind = 'restart' | 'update';

interface MaintenanceScope {
  readonly address: string;
  readonly providerUrl: string;
  readonly leaseUuid: string;
  readonly chainId: string;
}

/** Raw manifests stay in memory: neither chat persistence nor localStorage may contain them. */
export interface MaintenanceOperation extends MaintenanceScope {
  readonly operation: MaintenanceKind;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly baselineReleaseVersions: readonly number[];
  readonly manifest?: string;
  readonly previousManifest?: string;
  /** False only while no caller has handed this command to HTTP. */
  readonly dispatched?: boolean;
  /** Persist provider admission so a later read can safely attribute its release. */
  readonly accepted?: boolean;
  /** Persist whether Barney advised recovery, so old advice cannot start new work. */
  readonly recoveryAdvised?: boolean;
  /** Restore only this compact receipt if a successor is cancelled before HTTP. */
  readonly previousSettlement?: SettledMetadata;
  /** Bounded exact proof for advised commands that never reached HTTP. */
  readonly neverSentKeys?: readonly string[];
}

interface MaintenanceMetadata {
  readonly v: 1;
  readonly operation: MaintenanceKind;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly baselineReleaseVersions: readonly number[];
  readonly dispatched?: boolean;
  readonly accepted?: boolean;
  readonly recoveryAdvised?: boolean;
  readonly previousSettlement?: SettledMetadata;
  readonly neverSentKeys?: readonly string[];
}

interface MaintenanceInput extends Omit<MaintenanceScope, 'chainId'> {
  readonly chainId?: string;
  readonly operation: MaintenanceKind;
  readonly idempotencyKey?: string;
  readonly manifest?: string;
  readonly previousManifest?: string;
  readonly baselineReleaseVersions?: readonly number[];
  readonly expectPending?: boolean;
  /** Explicit confirmation to start another command after this settled key. */
  readonly previousOperationKey?: string;
  readonly recoveryIntentKey?: string;
}

export interface SettledMaintenanceOperation extends MaintenanceScope {
  readonly operation: MaintenanceKind;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly outcome: 'succeeded' | 'failed' | 'settled' | 'not_sent';
  readonly recoveryAdvised: boolean;
}

interface SettledMetadata extends Pick<MaintenanceMetadata, 'v' | 'operation' | 'idempotencyKey' | 'payloadHash'> {
  readonly settled: SettledMaintenanceOperation['outcome'];
  /** Compact so even a minimum legacy pending marker shrinks on settlement. */
  readonly r?: 1;
  readonly neverSentKeys?: readonly string[];
}

/** A local conflict or stale recovery plan must never be reported as a sent command. */
export class MaintenanceOperationRefusalError extends Error {
  readonly command?: MaintenanceOperation;
  constructor(message: string, command?: MaintenanceOperation) { super(message); this.command = command; }
}

/** A recovery can become obsolete without the original operation having failed. */
export class MaintenanceOperationSupersededError extends Error {}

/** The provider verdict and its registry projection remain valid. */
export class MaintenanceSettlementStorageError extends Error {
  readonly projectionApplied: boolean;
  constructor(message: string, projectionApplied = true) {
    super(message);
    this.projectionApplied = projectionApplied;
  }
}
class MaintenanceStorageError extends Error {}
export const MAINTENANCE_CLEANUP_MESSAGE = 'The provider outcome was verified, but its local recovery record could not be retired. Restore browser storage access and retry the same confirmation to finish local cleanup.';
export const MAINTENANCE_PROJECTION_MESSAGE = 'The provider outcome was verified, but browser storage could not be read to safely update the app or retire its recovery record. Restore browser storage access, then check app_status or retry the same confirmation.';

function missingOperation(): MaintenanceOperationSupersededError {
  return new MaintenanceOperationSupersededError('The saved maintenance operation no longer exists; it may have been settled or superseded in another tab.');
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const pending = new Map<string, MaintenanceOperation>();

function scopeFor(input: Omit<MaintenanceScope, 'chainId'> & { chainId?: string }): MaintenanceScope {
  let providerUrl: string;
  try {
    providerUrl = new URL(input.providerUrl).href.replace(/\/+$/, '');
  } catch {
    throw new Error('A valid provider URL is required to retain a maintenance operation.');
  }
  return {
    address: input.address.trim().toLowerCase(),
    providerUrl,
    leaseUuid: input.leaseUuid,
    chainId: input.chainId ?? runtimeConfig.PUBLIC_CHAIN_ID,
  };
}

function storageKey(scope: MaintenanceScope): string {
  // Include the chain endpoints as dev deployments can share a chain ID.
  return `barney:maintenance:v1:${encodeURIComponent(JSON.stringify([
    scope.chainId, runtimeConfig.PUBLIC_RPC_URL, runtimeConfig.PUBLIC_REST_URL,
    scope.address, scope.providerUrl, scope.leaseUuid,
  ]))}`;
}

function settledStorageKey(scope: MaintenanceScope): string {
  return `${storageKey(scope)}:settled`;
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    throw storageError();
  }
}

function parseNeverSentKeys(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAINTENANCE_NEVER_SENT_PROOF_LIMIT
    || value.some((key) => typeof key !== 'string' || !UUID_V4.test(key))
    || new Set(value).size !== value.length) throw new Error('Invalid never-sent proof.');
  return Object.freeze([...value]);
}

function recordNeverSentKeys(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object') return [];
  const keys = parseNeverSentKeys('neverSentKeys' in value ? value.neverSentKeys : undefined);
  if ('settled' in value && value.settled === 'not_sent') {
    // Adopt older builds' single tombstone without losing its proof when the
    // next command replaces that receipt.
    const legacy = parseSettled(value);
    return [...new Set([...keys, legacy.idempotencyKey])].slice(-MAINTENANCE_NEVER_SENT_PROOF_LIMIT);
  }
  return keys;
}

function isProofOnly(value: object): boolean {
  return 'v' in value && value.v === 1 && 'neverSentKeys' in value
    && Object.keys(value).every((key) => key === 'v' || key === 'neverSentKeys');
}

function parseSettled(value: unknown): SettledMetadata {
  if (!value || typeof value !== 'object') throw new Error();
  const record = value as Partial<SettledMetadata>;
  if (record.v !== 1 || (record.operation !== 'restart' && record.operation !== 'update')
    || typeof record.idempotencyKey !== 'string' || !UUID_V4.test(record.idempotencyKey)
    || typeof record.payloadHash !== 'string' || !SHA_256.test(record.payloadHash)
    || !['succeeded', 'failed', 'settled', 'not_sent'].includes(record.settled ?? '')
    || (record.r !== undefined && record.r !== 1)) throw new Error();
  const neverSentKeys = parseNeverSentKeys(record.neverSentKeys);
  if (record.settled !== 'not_sent' && neverSentKeys.includes(record.idempotencyKey)) throw new Error();
  return { v: 1, operation: record.operation, idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash, settled: record.settled!, ...(record.r === 1 && { r: 1 as const }),
    ...(record.neverSentKeys !== undefined && { neverSentKeys }) };
}

/** One nonsecret receipt per lease prevents old recovery advice from becoming
 * a new command in another tab or after a reload. No time-based expiration. */
export function getSettledMaintenanceOperation(
  address: string,
  providerUrl: string,
  leaseUuid: string,
  chainId = runtimeConfig.PUBLIC_CHAIN_ID,
): SettledMaintenanceOperation | undefined {
  const scope = scopeFor({ address, providerUrl, leaseUuid, chainId });
  const current = readRaw(storageKey(scope));
  const legacy = readRaw(settledStorageKey(scope));
  try {
    const currentValue: unknown = current === null ? undefined : JSON.parse(current);
    if (currentValue !== undefined) parseMaintenanceMetadata(currentValue);
    syncMaintenanceNeverSentProofs(scope, recordNeverSentKeys(currentValue));
    let value: SettledMetadata;
    if (currentValue && typeof currentValue === 'object' && 'settled' in currentValue) {
      value = parseSettled(currentValue);
    } else {
      if (legacy === null) return undefined;
      // Older releases wrote a separate receipt for every result and could have
      // issued retry advice without recording it. Preserve that safety barrier.
      const prior = JSON.parse(legacy) as Partial<SettledMaintenanceOperation> & { v?: number };
      value = parseSettled({ ...prior, settled: prior.outcome, r: 1 });
    }
    if (value.settled === 'not_sent') syncMaintenanceNeverSentProofs(scope, [...recordNeverSentKeys(currentValue), value.idempotencyKey]);
    return Object.freeze({ ...scope, operation: value.operation, idempotencyKey: value.idempotencyKey,
      payloadHash: value.payloadHash, outcome: value.settled, recoveryAdvised: value.r === 1 });
  } catch {
    throw new MaintenanceOperationRefusalError('The saved maintenance receipt is unreadable. Restore browser storage access before starting another command.');
  }
}

export function assertNewMaintenanceOperation(input: Omit<MaintenanceInput, 'operation'>): void {
  const receipt = getSettledMaintenanceOperation(input.address, input.providerUrl, input.leaseUuid, input.chainId);
  const intent = getMaintenanceRecoveryIntent(input);
  if (intent && input.recoveryIntentKey !== intent.idempotencyKey) {
    throw new MaintenanceOperationSupersededError('This tab still has recovery advice for an earlier command. Observe its outcome before explicitly requesting a new command.');
  }
  if (intent && !receipt) {
    throw new MaintenanceOperationSupersededError('This tab has recovery advice but no saved pending command or settled receipt. The provider outcome remains unknown; observe the current app state before further recovery. A new command cannot replace the missing record.');
  }
  if (receipt ? input.previousOperationKey !== receipt.idempotencyKey || input.idempotencyKey === receipt.idempotencyKey : input.previousOperationKey !== undefined) {
    throw new MaintenanceOperationSupersededError('The previous maintenance command has settled or changed. Observe its result before explicitly requesting a new command.');
  }
}

function settledMetadataFor(record: Pick<MaintenanceOperation, 'operation' | 'idempotencyKey' | 'payloadHash' | 'recoveryAdvised' | 'neverSentKeys'>, outcome: SettledMaintenanceOperation['outcome']): SettledMetadata {
  return { v: 1, operation: record.operation, idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash, settled: outcome, ...(record.recoveryAdvised && { r: 1 }),
    ...(record.neverSentKeys?.length && { neverSentKeys: record.neverSentKeys }) };
}

function persistSettled(record: Pick<MaintenanceOperation, 'operation' | 'idempotencyKey' | 'payloadHash' | 'recoveryAdvised' | 'neverSentKeys'> & MaintenanceScope, outcome: SettledMaintenanceOperation['outcome']): void {
  try {
    localStorage.setItem(storageKey(record), JSON.stringify(settledMetadataFor(record, outcome)));
  } catch {
    throw storageError();
  }
  // Removing the obsolete separate receipt is cleanup, not part of settlement.
  try { localStorage.removeItem(settledStorageKey(record)); } catch { /* Same-key receipt is authoritative. */ }
}

function metadataFor(record: MaintenanceOperation): MaintenanceMetadata {
  return {
    v: 1,
    operation: record.operation,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    baselineReleaseVersions: record.baselineReleaseVersions,
    ...(record.dispatched !== undefined && { dispatched: record.dispatched }),
    ...(record.accepted !== undefined && { accepted: record.accepted }),
    ...(record.recoveryAdvised !== undefined && { recoveryAdvised: record.recoveryAdvised }),
    ...(record.previousSettlement !== undefined && { previousSettlement: record.previousSettlement }),
    ...(record.neverSentKeys?.length && { neverSentKeys: record.neverSentKeys }),
  };
}

function storageError(): Error {
  return new MaintenanceStorageError('Barney cannot safely read or save this maintenance operation. Restore browser storage access before retrying; do not submit a new command.');
}

function parseMaintenanceMetadata(value: unknown): MaintenanceMetadata | undefined {
  if (typeof value !== 'object' || value === null) throw new Error();
  const neverSentKeys = recordNeverSentKeys(value);
  if (isProofOnly(value)) return undefined;
  if ('settled' in value) {
    parseSettled(value);
    return undefined;
  }
  const metadata = value as Partial<MaintenanceMetadata>;
  if (metadata.v !== 1
    || (metadata.operation !== 'restart' && metadata.operation !== 'update')
    || typeof metadata.idempotencyKey !== 'string' || !UUID_V4.test(metadata.idempotencyKey)
    || typeof metadata.payloadHash !== 'string' || !SHA_256.test(metadata.payloadHash)
    || (metadata.dispatched !== undefined && typeof metadata.dispatched !== 'boolean')
    || (metadata.accepted !== undefined && typeof metadata.accepted !== 'boolean')
    || (metadata.recoveryAdvised !== undefined && typeof metadata.recoveryAdvised !== 'boolean')
    || !Array.isArray(metadata.baselineReleaseVersions)
    || !metadata.baselineReleaseVersions.every((version: unknown) => typeof version === 'number' && Number.isSafeInteger(version) && version >= 0)) throw new Error();
  if (neverSentKeys.includes(metadata.idempotencyKey)) throw new Error();
  return {
    v: 1,
    operation: metadata.operation,
    idempotencyKey: metadata.idempotencyKey,
    payloadHash: metadata.payloadHash,
    baselineReleaseVersions: Object.freeze([...metadata.baselineReleaseVersions]),
    ...(metadata.dispatched !== undefined && { dispatched: metadata.dispatched }),
    ...(metadata.accepted !== undefined && { accepted: metadata.accepted }),
    // Earlier versions issued retry advice without tracking it. Only a
    // fresh record's explicit false proves that no such advice was emitted.
    recoveryAdvised: metadata.recoveryAdvised ?? true,
    ...(metadata.previousSettlement !== undefined && { previousSettlement: Object.freeze(parseSettled(metadata.previousSettlement)) }),
    ...(neverSentKeys.length && { neverSentKeys }),
  };
}

function readMetadata(key: string, onProofs?: (keys: readonly string[]) => void): MaintenanceMetadata | undefined {
  const raw = readRaw(key);
  if (raw === null) { onProofs?.([]); return undefined; }
  try {
    const value: unknown = JSON.parse(raw);
    const metadata = parseMaintenanceMetadata(value);
    onProofs?.(recordNeverSentKeys(value));
    return metadata;
  } catch {
    throw new Error('The saved maintenance operation is unreadable. Reconcile the existing operation before submitting another command.');
  }
}

function matches(record: MaintenanceOperation, metadata: MaintenanceMetadata): boolean {
  return record.idempotencyKey === metadata.idempotencyKey
    && record.operation === metadata.operation
    && record.payloadHash === metadata.payloadHash
    && JSON.stringify(record.baselineReleaseVersions) === JSON.stringify(metadata.baselineReleaseVersions);
}

function persist(key: string, record: MaintenanceOperation): void {
  try {
    localStorage.setItem(key, JSON.stringify(metadataFor(record)));
  } catch {
    throw storageError();
  }
}

/** Metadata survives reload, but an update's exact bytes must be supplied again to retry it. */
export function getPendingMaintenanceOperation(
  address: string,
  providerUrl: string,
  leaseUuid: string,
  chainId = runtimeConfig.PUBLIC_CHAIN_ID,
): MaintenanceOperation | undefined {
  const scope = scopeFor({ address, providerUrl, leaseUuid, chainId });
  const key = storageKey(scope);
  const metadata = readMetadata(key, (keys) => syncMaintenanceNeverSentProofs(scope, keys));
  const retained = pending.get(key);
  if (!metadata) {
    pending.delete(key);
    return undefined;
  }
  if (retained) {
    if (matches(retained, metadata)) {
      // Another tab may have dispatched or acknowledged the same operation.
      return Object.freeze({ ...retained, ...metadata });
    }
    // Another tab completed the old command and prepared a successor. Its
    // durable identity wins; the old raw payload must not survive that change.
    pending.delete(key);
  }
  return Object.freeze({ ...scope, ...metadata });
}

export function assertMaintenanceOperationMatches(
  record: MaintenanceOperation,
  input: Pick<MaintenanceInput, 'operation' | 'idempotencyKey' | 'expectPending'>,
): void {
  if (record.operation !== input.operation
    || (input.idempotencyKey !== undefined && record.idempotencyKey !== input.idempotencyKey)) {
    if (input.expectPending) {
      throw new MaintenanceOperationSupersededError('The saved recovery command is no longer pending; another command is now recorded for this app.');
    }
    throw new MaintenanceOperationRefusalError(`${record.operation === 'update' ? 'An' : 'A'} ${record.operation} is still unresolved for this app. Retry that exact operation or reconcile its outcome before submitting a new command.`, record);
  }
}

async function withScopeLock<T>(key: string, action: () => T): Promise<T> {
  // Coordinate other tabs when Web Locks is available. The fallback critical
  // section remains synchronous, so same-tab callers are safe.
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(key, action);
  }
  return action();
}

/**
 * Call before provider I/O. Unknown outcomes retain their key and exact payload,
 * including across new tool invocations. Each lease in a batch has its own scope.
 */
export async function prepareMaintenanceOperation(input: MaintenanceInput): Promise<{ command: MaintenanceOperation; created: boolean }> {
  if (input.idempotencyKey !== undefined && !UUID_V4.test(input.idempotencyKey)) {
    throw new Error('The maintenance operation key must be a canonical UUIDv4.');
  }
  if (input.operation === 'restart' && input.manifest !== undefined) {
    throw new Error('A restart operation cannot include an update manifest.');
  }
  const scope = scopeFor(input);
  const key = storageKey(scope);
  const initial = getPendingMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid, scope.chainId);
  if (initial) assertMaintenanceOperationMatches(initial, input);
  else if (input.expectPending) throw missingOperation();
  else assertNewMaintenanceOperation(input);
  if (!initial && !input.baselineReleaseVersions) {
    throw new Error('Read the release history before starting a maintenance operation so its outcome can be verified.');
  }
  if (input.baselineReleaseVersions && !input.baselineReleaseVersions.every((version) => Number.isSafeInteger(version) && version >= 0)) {
    throw new Error('The maintenance release history contains an invalid version.');
  }
  const manifest = input.manifest ?? initial?.manifest;
  if (input.operation === 'update' && manifest === undefined) {
    throw new Error('Retrying this update requires its exact original manifest bytes. Reconcile the pending outcome before submitting a different update.');
  }
  const payloadHash = await metaHashHex(manifest ?? '');

  const retain = (): { command: MaintenanceOperation; created: boolean } => {
    // Hashing yields. Re-read inside the critical section so concurrent callers
    // cannot mint separate keys for the same unresolved operation.
    const current = getPendingMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid, scope.chainId);
    if (!current && (initial || input.expectPending)) throw missingOperation();
    if (!current) assertNewMaintenanceOperation(input);
    if (current) {
      if (initial && !matches(initial, metadataFor(current))) {
        throw new MaintenanceOperationSupersededError('The saved maintenance operation changed during preparation; it may have been settled or superseded in another tab.');
      }
      assertMaintenanceOperationMatches(current, input);
      if (current.payloadHash !== payloadHash || (current.manifest !== undefined && current.manifest !== manifest)) {
        throw new MaintenanceOperationRefusalError('An update is still unresolved with different manifest bytes. Retry its exact original payload or reconcile its outcome before submitting a new command.', current);
      }
    }
    const retained = current;
    const priorReceipt = retained ? undefined : getSettledMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid, scope.chainId);
    const idempotencyKey = retained?.idempotencyKey ?? input.idempotencyKey ?? createMaintenanceIdempotencyKey();
    // A never-sent confirmation may itself be retried. Revoke only that proof
    // atomically with preparing its key again, before it can reach HTTP.
    const neverSentKeys = (retained?.neverSentKeys ?? recordNeverSentKeys(JSON.parse(readRaw(key) ?? 'null')))
      .filter((key) => key !== idempotencyKey);
    const record: MaintenanceOperation = Object.freeze({
      ...scope,
      operation: input.operation,
      idempotencyKey,
      payloadHash,
      baselineReleaseVersions: retained?.baselineReleaseVersions ?? Object.freeze([...input.baselineReleaseVersions!]),
      manifest,
      previousManifest: retained ? retained.previousManifest : input.previousManifest,
      dispatched: retained ? retained.dispatched : false,
      accepted: retained?.accepted,
      recoveryAdvised: retained?.recoveryAdvised ?? false,
      previousSettlement: retained?.previousSettlement ?? (priorReceipt ? settledMetadataFor(priorReceipt, priorReceipt.outcome) : undefined),
      ...(neverSentKeys.length && { neverSentKeys }),
    });
    // Persist before allowing any mutation, and never persist manifest secrets.
    persist(key, record);
    syncMaintenanceNeverSentProofs(scope, neverSentKeys);
    pending.set(key, record);
    return { command: record, created: retained === undefined };
  };

  return withScopeLock(key, retain);
}

/** Release only after the caller has verified a settled maintenance outcome. */
export async function completeMaintenanceOperation(
  record: MaintenanceOperation,
  beforeComplete?: () => void,
  outcome: SettledMaintenanceOperation['outcome'] = 'settled',
): Promise<void> {
  const key = storageKey(record);
  await withScopeLock(key, () => {
    beforeComplete?.();
    const metadata = readMetadata(key);
    if (!metadata) {
      pending.delete(key);
      return;
    }
    if (!matches(record, metadata)) return; // A stale result must not clear a newer command.
    const retained = pending.get(key);
    if (retained && retained.idempotencyKey !== record.idempotencyKey) return;
    persistSettled({ ...record, neverSentKeys: metadata.neverSentKeys,
      recoveryAdvised: metadata.recoveryAdvised || getMaintenanceRecoveryIntent(record)?.idempotencyKey === record.idempotencyKey }, outcome);
    pending.delete(key);
  });
}

/** Existing callers need only the stable operation handle. */
export async function getOrCreateMaintenanceOperation(input: MaintenanceInput): Promise<MaintenanceOperation> {
  return (await prepareMaintenanceOperation(input)).command;
}

async function markOperation(record: MaintenanceOperation, accepted: boolean, beforeMark?: () => void): Promise<void> {
  const key = storageKey(record);
  await withScopeLock(key, () => {
    beforeMark?.();
    const current = getPendingMaintenanceOperation(record.address, record.providerUrl, record.leaseUuid, record.chainId);
    if (!current || !matches(current, metadataFor(record))) {
      throw new MaintenanceOperationSupersededError('The saved maintenance operation changed before dispatch; it may have been settled or superseded in another tab.');
    }
    const updated = Object.freeze({ ...current, dispatched: true, ...(accepted && { accepted: true }) });
    persist(key, updated);
    pending.set(key, updated);
  });
}

/** Must finish before handing a maintenance POST to the network. */
export async function markMaintenanceOperationDispatched(record: MaintenanceOperation, beforeMark?: () => void): Promise<void> {
  await markOperation(record, false, beforeMark);
}

/** Acknowledged admission survives reload without retaining manifest secrets. */
export async function markMaintenanceOperationAccepted(record: MaintenanceOperation): Promise<void> {
  await markOperation(record, true);
}

/** Call before returning recovery advice, including read-only/reloaded recovery. */
export async function markMaintenanceRecoveryAdvised(record: MaintenanceOperation, onAdvice?: (advice: MaintenanceRecoveryAdvice) => void): Promise<void> {
  // An unsent command may disappear safely. Its temporary advice must not
  // replace an older sent command's still-visible recovery guard.
  rememberMaintenanceRecoveryIntent(record, true);
  onAdvice?.(maintenanceRecoveryAdvice(record));
  const key = storageKey(record);
  try { await withScopeLock(key, () => {
    const current = getPendingMaintenanceOperation(record.address, record.providerUrl, record.leaseUuid, record.chainId);
    if (current) {
      if (matches(record, metadataFor(current)) && (current.dispatched !== false || current.accepted)) rememberMaintenanceRecoveryIntent(record);
      if (!matches(record, metadataFor(current)) || current.recoveryAdvised) return;
      const updated = Object.freeze({ ...current, recoveryAdvised: true });
      persist(key, updated);
      pending.set(key, updated);
      return;
    }
    // A settling tab may have won the race. Keep this tab's intent without
    // growing its receipt or blocking routine work in every other tab.
  }); } catch { /* Local evidence still protects recovery when shared storage fails. */ }
}

/** Clear only a newly prepared operation that no concurrent caller dispatched. */
export async function discardUnsubmittedMaintenanceOperation(record: MaintenanceOperation): Promise<boolean> {
  const key = storageKey(record);
  return withScopeLock(key, () => {
    const current = getPendingMaintenanceOperation(record.address, record.providerUrl, record.leaseUuid, record.chainId);
    if (!current || !matches(current, metadataFor(record)) || current.dispatched !== false || current.accepted) return false;
    const neverSentKeys = [...new Set([...(current.neverSentKeys ?? []), current.idempotencyKey])]
      .slice(-MAINTENANCE_NEVER_SENT_PROOF_LIMIT);
    try {
      // Cancellation never changes the last provider command's identity. Keep
      // bounded exact zero-HTTP proof alongside that receipt (or on its own),
      // atomically with removal of the pending marker.
      localStorage.setItem(key, JSON.stringify({ ...(current.previousSettlement ?? { v: 1 }), neverSentKeys }));
    } catch {
      throw storageError();
    }
    pending.delete(key);
    syncMaintenanceNeverSentProofs(record, neverSentKeys);
    return true;
  });
}

/** An authoritative absent/terminal chain lease cannot execute retained work. */
export async function retireAbsentMaintenanceOperation(input: Omit<MaintenanceScope, 'chainId'> & { chainId?: string }): Promise<void> {
  try {
    let key: string;
    try {
      key = storageKey(scopeFor(input));
    } catch {
      // The chain's terminal/absent verdict remains valid even when a stale
      // registry entry has an invalid URL. Discard its memory-only payloads.
      for (const [entryKey, record] of pending) {
        if (record.address === input.address.trim().toLowerCase()
          && record.chainId === (input.chainId ?? runtimeConfig.PUBLIC_CHAIN_ID)
          && record.leaseUuid === input.leaseUuid) pending.delete(entryKey);
      }
      return;
    }
    try {
      await withScopeLock(key, () => {
        pending.delete(key);
        localStorage.removeItem(key);
        localStorage.removeItem(settledStorageKey(scopeFor(input)));
      });
    } catch {
      pending.delete(key);
      // Cleanup cannot turn a confirmed stop/status result into a failed action.
      // Log a bounded message, never the provider URL or raw storage contents.
      logError('maintenanceOperation.retireAbsent', storageError());
    }
  } finally {
    try { retireMaintenanceRecoveryIntent(input); } catch { /* Invalid stale provider URLs are already handled above. */ }
    releaseAbsentMaintenanceCompletions({ address: input.address, chainId: input.chainId ?? runtimeConfig.PUBLIC_CHAIN_ID, leaseUuid: input.leaseUuid });
  }
}

/** Commit read-only observations only while both the command and caller snapshot remain current. */
export async function commitMaintenanceObservation(
  record: MaintenanceOperation,
  observation: { settled: boolean; outcome?: SettledMaintenanceOperation['outcome']; isCurrent: () => boolean; apply: () => void },
): Promise<boolean> {
  const key = storageKey(record);
  return withScopeLock(key, () => {
    let metadata: MaintenanceMetadata | undefined;
    try { metadata = readMetadata(key); } catch (error) {
      if (observation.settled && error instanceof MaintenanceStorageError) {
        // The immutable provider baseline still establishes the verdict. Without
        // current identity, neither registry projection nor clean memo is safe.
        throw new MaintenanceSettlementStorageError(MAINTENANCE_PROJECTION_MESSAGE, false);
      }
      throw error;
    }
    // Absence is a stale result: another caller may have settled this command
    // and a successor during the provider reads. Never retain its raw payload.
    if (!metadata) {
      pending.delete(key);
      return false;
    }
    const retained = pending.get(key);
    if (retained && !matches(retained, metadata)) pending.delete(key);
    if (!matches(record, metadata)) return false;
    if (!observation.isCurrent()) return false;
    if (observation.settled) {
      try {
        persistSettled({ ...record, neverSentKeys: metadata.neverSentKeys,
          recoveryAdvised: metadata.recoveryAdvised || getMaintenanceRecoveryIntent(record)?.idempotencyKey === record.idempotencyKey }, observation.outcome ?? 'settled');
      } catch {
        observation.apply();
        throw new MaintenanceSettlementStorageError(MAINTENANCE_CLEANUP_MESSAGE);
      }
      pending.delete(key);
    }
    observation.apply();
    return true;
  });
}
