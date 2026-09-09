import { asLeaseUuid } from '@manifest-network/manifest-sdk';
import { getLeaseConnectionInfo, getLeaseStatus } from '@manifest-network/manifest-sdk/deploy';
import { type Lease, LeaseState } from './billing';
import { getProviders, getSKUs } from './sku';
import { getDomainAssignments } from './leaseDomains';
import { providerFetch } from './providerFetchAdapter';
import { withTimeout } from './utils';
import * as appRegistry from '../registry/appRegistry';
import type { AppEntry, ChainAppSnapshot } from '../registry/appRegistry';
import type { AppRegistryAccess, SigningContext } from '../ai/toolExecutor/types';
import { connectionPatch, deriveUrlFromConnection } from '../ai/toolExecutor/helpers';
import { extractUrlFromFredStatus } from '../ai/toolExecutor/deployUrl';
import { classifyProvisionStatus, isUnsettledProvisionStatus } from '../ai/toolExecutor/provisionStatus';
import { AI_TOOL_API_TIMEOUT_MS, APP_DISCOVERY_CONCURRENCY } from '../config/constants';
import { logError } from '../utils/errors';

interface DiscoveryOptions {
  signal?: AbortSignal;
  registry?: AppRegistryAccess;
}

const missingSize = (app: AppEntry): boolean => !app.size || app.size === 'unknown';
// Parsed cache entries and fresh transaction results need not have the same
// object-key insertion order. Compare their values, including nested metadata.
const snapshotKey = (app: AppEntry): string => JSON.stringify(app, (_key, value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value);
const unchanged = (current: AppEntry | null, snapshot: AppEntry): boolean =>
  current !== null && snapshotKey(current) === snapshotKey(snapshot);

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

/** Read provider observations; no manifest synthesis or chain transactions. */
export async function hydrateDiscoveredApps(
  address: string,
  apps: readonly AppEntry[],
  signing: Pick<SigningContext, 'authTokens'>,
  { signal, registry = appRegistry }: DiscoveryOptions = {},
): Promise<void> {
  signal?.throwIfAborted();
  const queue = apps.filter(app => app.providerUrl && app.chainState !== 'absent');
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      signal?.throwIfAborted();
      const snapshot = queue[next++];
      if (!unchanged(registry.getAppByLease(address, snapshot.leaseUuid), snapshot)) continue;
      const abort = new AbortController();
      const fetchWithAbort: typeof fetch = (input, init) => providerFetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal,
      });
      try {
        const statusToken = await withTimeout(
          signing.authTokens.getAuthToken(asLeaseUuid(snapshot.leaseUuid)),
          AI_TOOL_API_TIMEOUT_MS, 'App discovery authentication', signal,
        );
        signal?.throwIfAborted();
        // Provider tokens are one-time credentials. Mint through the same
        // shared tracker for each request, matching the SDK's appStatus flow.
        const connectionToken = await withTimeout(
          signing.authTokens.getAuthToken(asLeaseUuid(snapshot.leaseUuid)),
          AI_TOOL_API_TIMEOUT_MS, 'App discovery connection authentication', signal,
        );
        signal?.throwIfAborted();
        // Each endpoint contributes independent evidence. A stalled connection
        // read must not discard a completed readiness/failure observation.
        const observations = await Promise.allSettled([
          withTimeout(
            getLeaseStatus(snapshot.providerUrl, snapshot.leaseUuid, statusToken, fetchWithAbort, abort.signal, import.meta.env.DEV),
            AI_TOOL_API_TIMEOUT_MS, 'App discovery status', signal,
          ),
          withTimeout(
            getLeaseConnectionInfo(snapshot.providerUrl, snapshot.leaseUuid, connectionToken, fetchWithAbort, import.meta.env.DEV),
            AI_TOOL_API_TIMEOUT_MS, 'App discovery connection', signal,
          ),
        ]);
        signal?.throwIfAborted();
        if (!unchanged(registry.getAppByLease(address, snapshot.leaseUuid), snapshot)) continue;
        const [statusResult, connectionResult] = observations;
        if (statusResult.status === 'rejected') logError('appDiscovery.status', statusResult.reason);
        if (connectionResult.status === 'rejected') logError('appDiscovery.connection', connectionResult.reason);
        const status = statusResult.status === 'fulfilled' ? statusResult.value : undefined;
        const response = connectionResult.status === 'fulfilled' ? connectionResult.value : undefined;
        const connection = response?.lease_uuid === snapshot.leaseUuid
          && response.tenant === address && response.provider_uuid === snapshot.providerUuid
          ? response.connection : undefined;
        const shaped = connection ? deriveUrlFromConnection(connection) : undefined;
        const patch: Partial<AppEntry> = connectionPatch({
          url: shaped?.url ?? (status ? extractUrlFromFredStatus(status) : undefined),
          connection: shaped?.connection ?? connection,
        }, snapshot);
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
        if (Object.keys(patch).length > 0) registry.updateApp(address, snapshot.leaseUuid, patch);
      } catch (error) {
        signal?.throwIfAborted();
        // Unreachable providers and refused/timed-out signing are not evidence
        // about whether the workload is running. A later pass can retry.
        logError('appDiscovery.provider', error);
      } finally {
        abort.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(APP_DISCOVERY_CONCURRENCY, queue.length) }, worker));
}
