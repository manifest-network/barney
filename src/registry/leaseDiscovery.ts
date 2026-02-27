/**
 * Lease Discovery — detects on-chain leases not in the local registry
 * and enriches them with provider/connection data in the background.
 *
 * Phase 1 (sync): discoverUnknownLeases — adds skeleton AppEntry records
 * Phase 2 (async): enrichDiscoveredLeases — fetches provider URL, release
 *   manifest, connection info, and derives proper app names
 */

import type { Lease } from '../api/billing';
import { LeaseState } from '../api/billing';
import { getProvider, getSKU } from '../api/sku';
import { getLeaseReleases, getLeaseInfo } from '../api/fred';
import {
  getLeaseConnectionInfo,
  createSignMessage,
  createAuthToken,
} from '../api/provider-api';
import {
  getAppByLease,
  addApp,
  updateApp,
  getApps,
  sanitizeManifestForStorage,
  MAX_APP_NAME_LENGTH,
  type AppEntry,
  type AppStatus,
} from './appRegistry';
import { deriveAppNameFromImage } from '../ai/manifest';
import { logError } from '../utils/errors';
import { LEASE_DISCOVERY_MAX_CONCURRENT } from '../config/constants';
import type { SignArbitraryFn } from '../ai/toolExecutor/types';

/** Terminal lease states — these leases should not be discovered. */
const TERMINAL_STATES = new Set<LeaseState>([
  LeaseState.LEASE_STATE_CLOSED,
  LeaseState.LEASE_STATE_REJECTED,
  LeaseState.LEASE_STATE_EXPIRED,
]);

/** Guard against concurrent enrichment of the same lease, scoped per wallet address. */
const enrichmentInFlight = new Map<string, Set<string>>();

/** Get or create the in-flight set for a given address. */
function getInFlightSet(address: string): Set<string> {
  let set = enrichmentInFlight.get(address);
  if (!set) {
    set = new Set<string>();
    enrichmentInFlight.set(address, set);
  }
  return set;
}

/**
 * Map on-chain lease state to AppStatus for registry entries.
 */
function leaseStateToAppStatus(state: LeaseState): AppStatus {
  switch (state) {
    case LeaseState.LEASE_STATE_ACTIVE:
      return 'running';
    case LeaseState.LEASE_STATE_PENDING:
      return 'deploying';
    default:
      return 'stopped';
  }
}

// MAX_APP_NAME_LENGTH imported from appRegistry — single source of truth.

/** Build a set of all app names currently in the registry for a given address. */
function getExistingNames(address: string): Set<string> {
  return new Set(getApps(address).map((a) => a.name));
}

/**
 * Generate a unique name for a discovered lease that doesn't collide
 * with existing registry entries or already-claimed names in this batch.
 *
 * @param baseName - the desired name before deduplication
 * @param existingNames - pre-built set of names already taken (registry + batch-claimed)
 */
function uniquifyName(baseName: string, existingNames: Set<string>): string {
  if (!existingNames.has(baseName) && baseName.length <= MAX_APP_NAME_LENGTH) return baseName;

  // Truncate base so suffix fits within the limit (e.g. "-99" = 3 chars)
  const maxBase = MAX_APP_NAME_LENGTH - 4; // room for "-" + up to 3 digits
  const truncated = baseName.slice(0, maxBase).replace(/-+$/, '').replace(/^-+/, '');

  // If truncation left nothing useful, go straight to UUID fallback
  if (!truncated) {
    return `lease-${crypto.randomUUID().slice(0, 8)}`;
  }

  // Try the truncated base before appending a numeric suffix
  if (!existingNames.has(truncated)) return truncated;

  for (let i = 2; i <= 100; i++) {
    const candidate = `${truncated}-${i}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  // Extremely unlikely — fall back to UUID-based name
  return `lease-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Phase 1: Detect on-chain leases that aren't in the local registry
 * and add skeleton AppEntry records. Returns the UUIDs of newly discovered leases.
 *
 * Skips terminal-state leases (CLOSED, REJECTED, EXPIRED) and leases
 * already tracked in the registry.
 */
export function discoverUnknownLeases(address: string, allLeases: Lease[]): string[] {
  const discovered: string[] = [];
  const existingNames = getExistingNames(address);

  for (const lease of allLeases) {
    // Skip terminal states
    if (TERMINAL_STATES.has(lease.state)) continue;

    // Skip if already tracked
    if (getAppByLease(address, lease.uuid)) continue;

    const baseName = `lease-${lease.uuid.slice(0, 8)}`;
    const name = uniquifyName(baseName, existingNames);
    existingNames.add(name);

    const entry: AppEntry = {
      name,
      leaseUuid: lease.uuid,
      size: 'unknown',
      providerUuid: lease.providerUuid,
      providerUrl: '',
      createdAt: lease.createdAt ? new Date(lease.createdAt).getTime() : Date.now(),
      status: leaseStateToAppStatus(lease.state),
    };

    try {
      addApp(address, entry);
      discovered.push(lease.uuid);
    } catch (error) {
      logError('leaseDiscovery.discoverUnknownLeases.addApp', error);
      // localStorage full — all subsequent writes will also fail, stop early
      break;
    }
  }

  return discovered;
}

/**
 * Create a provider auth token for a specific lease.
 * Same pattern as toolExecutor/utils.ts:getProviderAuthToken.
 */
async function getAuthToken(
  address: string,
  leaseUuid: string,
  signArbitrary: SignArbitraryFn
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = createSignMessage(address, leaseUuid, timestamp);
  const signResult = await signArbitrary(address, message);
  return createAuthToken(address, leaseUuid, timestamp, signResult.pub_key.value, signResult.signature);
}

/** Data fetched for a single lease (before name resolution). */
interface EnrichmentData {
  leaseUuid: string;
  updates: Partial<Omit<AppEntry, 'leaseUuid'>>;
}

/**
 * Fetch enrichment data for a single lease. Returns the updates without
 * resolving the final app name — name resolution happens sequentially
 * in the caller to avoid races on the shared claimedNames set.
 */
async function fetchLeaseData(
  address: string,
  lease: Lease,
  signArbitrary: SignArbitraryFn | undefined,
): Promise<EnrichmentData> {
  const updates: Partial<Omit<AppEntry, 'leaseUuid'>> = {};

  // 1. Fetch provider → get apiUrl
  try {
    const provider = await getProvider(lease.providerUuid);
    if (provider?.apiUrl) {
      updates.providerUrl = provider.apiUrl;
    }
  } catch (error) {
    logError(`leaseDiscovery.fetchLeaseData.getProvider[${lease.providerUuid}]`, error);
  }

  // 2. Fetch SKU → derive size from name (e.g. "docker-micro" → "micro")
  const skuUuid = lease.items?.[0]?.skuUuid;
  if (skuUuid) {
    try {
      const sku = await getSKU(skuUuid);
      if (sku?.name) {
        updates.size = sku.name.replace(/^docker-/, '');
      }
    } catch (error) {
      logError(`leaseDiscovery.fetchLeaseData.getSKU[${skuUuid}]`, error);
    }
  }

  // 3. If signArbitrary is available, fetch releases and connection info
  let authToken: string | undefined;
  if (signArbitrary && updates.providerUrl) {
    try {
      authToken = await getAuthToken(address, lease.uuid, signArbitrary);
    } catch (error) {
      logError('leaseDiscovery.fetchLeaseData.getAuthToken', error);
    }

    if (authToken) {
      const [releasesResult, connectionResult] = await Promise.allSettled([
        getLeaseReleases(updates.providerUrl, lease.uuid, authToken),
        getLeaseConnectionInfo(updates.providerUrl, lease.uuid, authToken),
      ]);

      // Log individual Fred API failures
      if (releasesResult.status === 'rejected') {
        logError('leaseDiscovery.fetchLeaseData.getLeaseReleases', releasesResult.reason);
      }
      if (connectionResult.status === 'rejected') {
        logError('leaseDiscovery.fetchLeaseData.getLeaseConnectionInfo', connectionResult.reason);
      }

      // Extract raw image name and manifest from latest release
      if (releasesResult.status === 'fulfilled' && releasesResult.value.releases.length > 0) {
        const latestRelease = releasesResult.value.releases[releasesResult.value.releases.length - 1];
        if (latestRelease.image) {
          // Store the derived name candidate — final dedup happens sequentially in the caller
          updates.name = deriveAppNameFromImage(latestRelease.image);
        }
        if (latestRelease.manifest) {
          try {
            const parsed = JSON.parse(latestRelease.manifest);
            updates.manifest = sanitizeManifestForStorage(JSON.stringify(parsed, null, 2));
          } catch (error) {
            logError('leaseDiscovery.fetchLeaseData.parseManifest', error);
          }
        }
      }

      // Extract connection details
      if (connectionResult.status === 'fulfilled') {
        const conn = connectionResult.value.connection;
        updates.connection = {
          host: conn.host,
          fqdn: conn.fqdn,
          ports: conn.ports,
          instances: conn.instances,
          services: conn.services,
        };
      }
    }
  }

  // 4. Fallback: try getLeaseInfo for basic connection details if we didn't get them above
  if (signArbitrary && updates.providerUrl && !updates.connection) {
    try {
      if (!authToken) {
        authToken = await getAuthToken(address, lease.uuid, signArbitrary);
      }
      const info = await getLeaseInfo(updates.providerUrl, lease.uuid, authToken);
      if (info) {
        updates.connection = {
          host: info.host,
          ports: info.ports,
        };
      }
    } catch (error) {
      logError('leaseDiscovery.fetchLeaseData.getLeaseInfo', error);
    }
  }

  return { leaseUuid: lease.uuid, updates };
}

/**
 * Phase 2: Enrich discovered leases with provider URL, release manifest,
 * connection info, and proper app names. Processes in batches to limit concurrency.
 *
 * @param address - wallet address
 * @param leaseUuids - UUIDs of newly discovered leases to enrich
 * @param leaseMap - Map of lease UUID → Lease object for quick lookup
 * @param signArbitrary - optional signing function for authenticated Fred requests
 */
export async function enrichDiscoveredLeases(
  address: string,
  leaseUuids: string[],
  leaseMap: Map<string, Lease>,
  signArbitrary?: SignArbitraryFn
): Promise<void> {
  // Filter out leases already being enriched (scoped per address)
  const inFlight = getInFlightSet(address);
  const toEnrich = leaseUuids.filter((uuid) => {
    if (inFlight.has(uuid)) return false;
    inFlight.add(uuid);
    return true;
  });

  if (toEnrich.length === 0) return;

  try {
    // Build names set once; track names claimed during this run to prevent duplicates.
    const existingNames = getExistingNames(address);

    // Process in batches of LEASE_DISCOVERY_MAX_CONCURRENT
    for (let i = 0; i < toEnrich.length; i += LEASE_DISCOVERY_MAX_CONCURRENT) {
      const batch = toEnrich.slice(i, i + LEASE_DISCOVERY_MAX_CONCURRENT);

      // Fetch data concurrently
      const results = await Promise.allSettled(
        batch.map((uuid) => {
          const lease = leaseMap.get(uuid);
          if (!lease) {
            logError('leaseDiscovery.enrichDiscoveredLeases', new Error(`Lease ${uuid} not found in leaseMap`));
            return Promise.resolve(undefined);
          }
          return fetchLeaseData(address, lease, signArbitrary);
        })
      );

      // Resolve names and apply updates sequentially (no races on existingNames)
      for (let idx = 0; idx < results.length; idx++) {
        const result = results[idx];
        if (result.status === 'rejected') {
          logError(`leaseDiscovery.enrichDiscoveredLeases.fetchLeaseData[${batch[idx]}]`, result.reason);
          continue;
        }
        if (!result.value) continue;
        const { leaseUuid, updates } = result.value;

        // Deduplicate the derived name against registry + already-claimed names
        if (updates.name) {
          updates.name = uniquifyName(updates.name, existingNames);
          existingNames.add(updates.name);
        }

        if (Object.keys(updates).length > 0) {
          const updated = updateApp(address, leaseUuid, updates);
          if (!updated) {
            logError('leaseDiscovery.enrichDiscoveredLeases.updateApp',
              new Error(`Failed to update lease ${leaseUuid} — entry may have been removed`));
          }
        }
      }
    }
  } finally {
    // Clean up in-flight tracking
    for (const uuid of toEnrich) {
      inFlight.delete(uuid);
    }
    if (inFlight.size === 0) {
      enrichmentInFlight.delete(address);
    }
  }
}

/** Visible for testing — reset the enrichment guard for all addresses. */
export function _resetEnrichmentInFlight(): void {
  enrichmentInFlight.clear();
}
