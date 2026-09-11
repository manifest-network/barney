import { asLeaseUuid } from '@manifest-network/manifest-sdk';
import { getLeaseConnectionInfo, getLeaseStatus, type ConnectionDetails } from '@manifest-network/manifest-sdk/deploy';
import { type Lease, LeaseState } from './billing';
import { getProviders, getSKUs } from './sku';
import { getDomainAssignments } from './leaseDomains';
import { providerFetch } from './providerFetchAdapter';
import { withTimeout } from './utils';
import * as appRegistry from '../registry/appRegistry';
import type { AppEntry, ChainAppSnapshot } from '../registry/appRegistry';
import type { AppRegistryAccess, SigningContext } from '../ai/toolExecutor/types';
import { refreshAppConnection } from '../ai/toolExecutor/deployUrl';
import { classifyProvisionStatus, isUnsettledProvisionStatus } from '../ai/toolExecutor/provisionStatus';
import { AI_TOOL_API_TIMEOUT_MS, APP_RECOVERY_TIMEOUT_MS } from '../config/constants';
import { logError } from '../utils/errors';

interface DiscoveryOptions {
  signal?: AbortSignal;
  registry?: AppRegistryAccess;
}

const missingSize = (app: AppEntry): boolean => !app.size || app.size === 'unknown';
// Persistence strips unsupported provider fields (for example protocol), while
// the memory fallback retains them. Normalize both sides to the registry schema
// and sort nested keys so our own provider writes never reset the retry budget.
export const recoverySnapshotKey = (app: AppEntry): string => JSON.stringify(appRegistry.AppEntrySchema.parse(app), (_key, value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value);
const unchanged = (current: AppEntry | null, snapshot: AppEntry): boolean =>
  current !== null && recoverySnapshotKey(current) === recoverySnapshotKey(snapshot);

/** Recover live leases independently of browser storage or catalog availability. */
export async function discoverTenantApps(
  address: string,
  leases: readonly Lease[],
  { signal, registry = appRegistry }: DiscoveryOptions = {},
): Promise<AppEntry[]> {
  signal?.throwIfAborted();
  const baseline = new Map(registry.getApps(address).map(app => [app.leaseUuid, app]));
  const candidates = leases.filter(lease => {
    const previous = baseline.get(lease.uuid);
    return lease.tenant === address
      && (lease.state === LeaseState.LEASE_STATE_ACTIVE || lease.state === LeaseState.LEASE_STATE_PENDING)
      && lease.createdAt instanceof Date && Number.isFinite(lease.createdAt.getTime())
      && (!previous || !previous.providerUrl || missingSize(previous));
  });
  if (candidates.length === 0) return [];

  // A provider/SKU can be inactive while its existing leases remain live.
  // Independent failures must not hide authoritative chain inventory.
  const [providerResult, skuResult] = await Promise.allSettled([
    withTimeout(getProviders(false), AI_TOOL_API_TIMEOUT_MS, 'App discovery providers', signal),
    withTimeout(getSKUs(false), AI_TOOL_API_TIMEOUT_MS, 'App discovery SKUs', signal),
  ]);
  signal?.throwIfAborted();
  if (providerResult.status === 'rejected') logError('appDiscovery.providers', providerResult.reason);
  if (skuResult.status === 'rejected') logError('appDiscovery.skus', skuResult.reason);
  const providers = new Map((providerResult.status === 'fulfilled' ? providerResult.value : [])
    .map(provider => [provider.uuid, provider]));
  const skus = new Map((skuResult.status === 'fulfilled' ? skuResult.value : [])
    .map(sku => [sku.uuid, sku]));
  const snapshots: ChainAppSnapshot[] = [];
  for (const lease of candidates) {
    const leaseSkus = lease.items.map(item => skus.get(item.skuUuid));
    const allSizesKnown = leaseSkus.length > 0
      && leaseSkus.every(sku => sku?.providerUuid === lease.providerUuid && sku.name);
    const size = allSizesKnown ? [...new Set(leaseSkus.map(sku => sku!.name))].join(', ') : undefined;
    const providerUrl = providers.get(lease.providerUuid)?.apiUrl || undefined;
    const previous = baseline.get(lease.uuid);
    if (previous) {
      // Retry absent metadata after a catalog outage, without overwriting a
      // concurrent deployment, stop, rename, or fresher provider observation.
      if (!unchanged(registry.getAppByLease(address, lease.uuid), previous)) continue;
      const patch: Partial<AppEntry> = {};
      if (!previous.providerUrl && providerUrl) patch.providerUrl = providerUrl;
      if (missingSize(previous) && size) patch.size = size;
      if (Object.keys(patch).length > 0) registry.updateApp(address, lease.uuid, patch);
      continue;
    }
    snapshots.push({
      leaseUuid: lease.uuid,
      providerUuid: lease.providerUuid,
      createdAt: lease.createdAt.getTime(),
      chainState: lease.state === LeaseState.LEASE_STATE_ACTIVE ? 'active' : 'pending',
      size,
      providerUrl,
      customDomains: getDomainAssignments(lease.items),
    });
  }
  return registry.discoverAppsFromChain(address, snapshots);
}

export interface AppRecoveryObservation {
  /** The actual post-write snapshot, so the driver does not reset its own budget. */
  app: AppEntry;
  complete: boolean;
}

// The SDK serializes signing globally and cannot cancel an already-enqueued
// mint. A timed-out round must not enqueue another mint behind that same one.
const pendingAuthentications = new WeakSet<SigningContext['authTokens']>();
export function hasPendingRecoveryAuthentication(authTokens: SigningContext['authTokens']): boolean {
  return pendingAuthentications.has(authTokens);
}

function recoveryAuthToken(signing: Pick<SigningContext, 'authTokens'>, leaseUuid: string): Promise<string> {
  if (pendingAuthentications.has(signing.authTokens)) {
    return Promise.reject(new Error('Previous app recovery authentication is still pending'));
  }
  pendingAuthentications.add(signing.authTokens);
  try {
    return signing.authTokens.getAuthToken(asLeaseUuid(leaseUuid))
      .finally(() => pendingAuthentications.delete(signing.authTokens));
  } catch (error) {
    pendingAuthentications.delete(signing.authTokens);
    return Promise.reject(error);
  }
}

/** Missing port fields can be provisional; explicit empty inventories are evidence. */
function hasEmptyEndpointInventory(connection: ConnectionDetails): boolean {
  const endpoints = connection.services && Object.keys(connection.services).length > 0
    ? Object.values(connection.services).flatMap<Pick<ConnectionDetails, 'ports'>>(
      service => service.instances?.length ? service.instances : [service],
    )
    : connection.instances?.length ? connection.instances : [connection];
  return endpoints.every(endpoint => endpoint.ports !== undefined && Object.keys(endpoint.ports).length === 0);
}

/**
 * Read one app's provider observations with a single deadline across signatures
 * and endpoint reads. Scheduling and retries belong to the background driver;
 * explicit status commands remain independent of its session retry budget.
 */
export async function hydrateDiscoveredApp(
  address: string,
  snapshot: AppEntry,
  signing: Pick<SigningContext, 'authTokens'>,
  { signal, registry = appRegistry }: DiscoveryOptions = {},
): Promise<AppRecoveryObservation | undefined> {
  signal?.throwIfAborted();
  if (!snapshot.providerUrl || snapshot.chainState === 'absent'
    || !unchanged(registry.getAppByLease(address, snapshot.leaseUuid), snapshot)) return;
  const round = new AbortController();
  const roundSignal = signal ? AbortSignal.any([signal, round.signal]) : round.signal;
  const deadline = setTimeout(() => round.abort(), APP_RECOVERY_TIMEOUT_MS);
  const fetchWithAbort: typeof fetch = (input, init) => providerFetch(input, {
    ...init,
    signal: AbortSignal.any([roundSignal, ...(init?.signal ? [init.signal] : [])]),
  });
  try {
    const statusToken = await withTimeout(
      recoveryAuthToken(signing, snapshot.leaseUuid),
      AI_TOOL_API_TIMEOUT_MS, 'App discovery authentication', roundSignal,
    );
    roundSignal.throwIfAborted();
    const readConnection = async () => {
      // Each request needs its own one-time credential from the shared tracker.
      const connectionToken = await withTimeout(
        recoveryAuthToken(signing, snapshot.leaseUuid),
        AI_TOOL_API_TIMEOUT_MS, 'App discovery connection authentication', roundSignal,
      );
      roundSignal.throwIfAborted();
      return withTimeout(
        getLeaseConnectionInfo(snapshot.providerUrl, snapshot.leaseUuid, connectionToken, fetchWithAbort, import.meta.env.DEV),
        AI_TOOL_API_TIMEOUT_MS, 'App discovery connection', roundSignal,
      );
    };
    // Start status immediately: stalled connection authentication or I/O must
    // not discard a completed readiness/failure observation.
    const observations = await Promise.allSettled([
      withTimeout(
        getLeaseStatus(snapshot.providerUrl, snapshot.leaseUuid, statusToken, fetchWithAbort, roundSignal, import.meta.env.DEV),
        AI_TOOL_API_TIMEOUT_MS, 'App discovery status', roundSignal,
      ),
      readConnection(),
    ]);
    signal?.throwIfAborted();
    if (!unchanged(registry.getAppByLease(address, snapshot.leaseUuid), snapshot)) return;
    const [statusResult, connectionResult] = observations;
    if (statusResult.status === 'rejected') logError('appDiscovery.status', statusResult.reason);
    if (connectionResult.status === 'rejected') logError('appDiscovery.connection', connectionResult.reason);
    const status = statusResult.status === 'fulfilled' ? statusResult.value : undefined;
    const response = connectionResult.status === 'fulfilled' ? connectionResult.value : undefined;
    const connection = response?.lease_uuid === snapshot.leaseUuid
      && response.tenant === address && response.provider_uuid === snapshot.providerUuid
      ? response.connection : undefined;
    const patch: Partial<AppEntry> = refreshAppConnection(status, connection, snapshot).patch;
    if (status) {
      const observed = classifyProvisionStatus(status.provision_status);
      const terminal = status.state === LeaseState.LEASE_STATE_CLOSED
        || status.state === LeaseState.LEASE_STATE_REJECTED
        || status.state === LeaseState.LEASE_STATE_EXPIRED;
      if (terminal) patch.provisionState = 'failed';
      else if (observed !== undefined
        && !(snapshot.provisionState === 'confirmed' && isUnsettledProvisionStatus(status.provision_status))) {
        patch.provisionState = observed;
      }
    }
    const updated = Object.keys(patch).length > 0
      ? registry.updateApp(address, snapshot.leaseUuid, patch)
      : snapshot;
    if (updated) return {
      app: updated,
      complete: updated.provisionState === 'failed'
        || (updated.provisionState === 'confirmed' && !!connection
          && (!!updated.url || hasEmptyEndpointInventory(connection))),
    };
  } catch (error) {
    signal?.throwIfAborted();
    // Unreachable providers and refused/timed-out signing are not evidence
    // about whether the workload is running. A later pass can retry.
    logError('appDiscovery.provider', error);
  } finally {
    clearTimeout(deadline);
    round.abort();
  }
}
