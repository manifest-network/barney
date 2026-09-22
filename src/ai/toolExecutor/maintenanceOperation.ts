import { createMaintenanceIdempotencyKey, metaHashHex } from '@manifest-network/manifest-sdk/deploy';
import { runtimeConfig } from '../../config/runtimeConfig';

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
}

interface MaintenanceMetadata {
  readonly v: 1;
  readonly operation: MaintenanceKind;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly baselineReleaseVersions: readonly number[];
}

interface MaintenanceInput extends Omit<MaintenanceScope, 'chainId'> {
  readonly chainId?: string;
  readonly operation: MaintenanceKind;
  readonly idempotencyKey?: string;
  readonly manifest?: string;
  readonly previousManifest?: string;
  readonly baselineReleaseVersions?: readonly number[];
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

function metadataFor(record: MaintenanceOperation): MaintenanceMetadata {
  return {
    v: 1,
    operation: record.operation,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    baselineReleaseVersions: record.baselineReleaseVersions,
  };
}

function storageError(): Error {
  return new Error('Barney cannot safely read or save this maintenance operation. Restore browser storage access before retrying; do not submit a new command.');
}

function readMetadata(key: string): MaintenanceMetadata | undefined {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    throw storageError();
  }
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) throw new Error();
    const metadata = value as Partial<MaintenanceMetadata>;
    if (metadata.v !== 1
      || (metadata.operation !== 'restart' && metadata.operation !== 'update')
      || typeof metadata.idempotencyKey !== 'string' || !UUID_V4.test(metadata.idempotencyKey)
      || typeof metadata.payloadHash !== 'string' || !SHA_256.test(metadata.payloadHash)
      || !Array.isArray(metadata.baselineReleaseVersions)
      || !metadata.baselineReleaseVersions.every((version: unknown) => typeof version === 'number' && Number.isSafeInteger(version) && version >= 0)) throw new Error();
    return {
      v: 1,
      operation: metadata.operation,
      idempotencyKey: metadata.idempotencyKey,
      payloadHash: metadata.payloadHash,
      baselineReleaseVersions: Object.freeze([...metadata.baselineReleaseVersions]),
    };
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
  const metadata = readMetadata(key);
  const retained = pending.get(key);
  if (retained) {
    if (metadata && !matches(retained, metadata)) {
      throw new Error('Another maintenance operation is recorded for this app. Reconcile the pending operations before retrying.');
    }
    return retained;
  }
  if (!metadata) return undefined;
  return Object.freeze({ ...scope, ...metadata });
}

function assertSameOperation(record: MaintenanceOperation, input: MaintenanceInput): void {
  if (record.operation !== input.operation
    || (input.idempotencyKey !== undefined && record.idempotencyKey !== input.idempotencyKey)) {
    throw new Error(`A ${record.operation} is still unresolved for this app. Retry that exact operation or reconcile its outcome before submitting a new command.`);
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
export async function getOrCreateMaintenanceOperation(input: MaintenanceInput): Promise<MaintenanceOperation> {
  if (input.idempotencyKey !== undefined && !UUID_V4.test(input.idempotencyKey)) {
    throw new Error('The maintenance operation key must be a canonical UUIDv4.');
  }
  if (input.operation === 'restart' && input.manifest !== undefined) {
    throw new Error('A restart operation cannot include an update manifest.');
  }
  const scope = scopeFor(input);
  const key = storageKey(scope);
  const initial = getPendingMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid, scope.chainId);
  if (initial) assertSameOperation(initial, input);
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

  const retain = (): MaintenanceOperation => {
    // Hashing yields. Re-read inside the critical section so concurrent callers
    // cannot mint separate keys for the same unresolved operation.
    const current = getPendingMaintenanceOperation(scope.address, scope.providerUrl, scope.leaseUuid, scope.chainId);
    if (current) {
      assertSameOperation(current, input);
      if (current.payloadHash !== payloadHash || (current.manifest !== undefined && current.manifest !== manifest)) {
        throw new Error('An update is still unresolved with different manifest bytes. Retry its exact original payload or reconcile its outcome before submitting a new command.');
      }
    }
    const retained = current ?? initial;
    const record: MaintenanceOperation = Object.freeze({
      ...scope,
      operation: input.operation,
      idempotencyKey: retained?.idempotencyKey ?? input.idempotencyKey ?? createMaintenanceIdempotencyKey(),
      payloadHash,
      baselineReleaseVersions: retained?.baselineReleaseVersions ?? Object.freeze([...input.baselineReleaseVersions!]),
      manifest,
      previousManifest: retained ? retained.previousManifest : input.previousManifest,
    });
    // Persist before allowing any mutation, and never persist manifest secrets.
    persist(key, record);
    pending.set(key, record);
    return record;
  };

  return withScopeLock(key, retain);
}

/** Release only after the caller has verified a settled maintenance outcome. */
export async function completeMaintenanceOperation(record: MaintenanceOperation): Promise<void> {
  const key = storageKey(record);
  await withScopeLock(key, () => {
    const metadata = readMetadata(key);
    if (metadata && !matches(record, metadata)) return; // A stale result must not clear a newer command.
    const retained = pending.get(key);
    if (retained && retained.idempotencyKey !== record.idempotencyKey) return;
    try {
      localStorage.removeItem(key);
    } catch {
      throw storageError();
    }
    pending.delete(key);
  });
}
