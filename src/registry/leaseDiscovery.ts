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

/** Guard against concurrent enrichment of the same lease. */
const enrichmentInFlight = new Set<string>();

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

/**
 * Generate a unique name for a discovered lease that doesn't collide
 * with existing registry entries.
 */
function uniquifyName(baseName: string, address: string): string {
  const apps = getApps(address);
  const existingNames = new Set(apps.map((a) => a.name));
  if (!existingNames.has(baseName)) return baseName;

  for (let i = 2; i <= 100; i++) {
    const candidate = `${baseName}-${i}`;
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

  for (const lease of allLeases) {
    // Skip terminal states
    if (TERMINAL_STATES.has(lease.state)) continue;

    // Skip if already tracked
    if (getAppByLease(address, lease.uuid)) continue;

    const baseName = `lease-${lease.uuid.slice(0, 8)}`;
    const name = uniquifyName(baseName, address);

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

/**
 * Enrich a single discovered lease with provider URL, size, release manifest,
 * and connection details. Silently handles errors — partial enrichment is fine.
 *
 * @param claimedNames - names already claimed by other leases in this batch,
 *   used to prevent duplicate names when concurrent enrichments derive the same image name.
 */
async function enrichSingleLease(
  address: string,
  lease: Lease,
  signArbitrary: SignArbitraryFn | undefined,
  claimedNames: Set<string>
): Promise<void> {
  const updates: Partial<Omit<AppEntry, 'leaseUuid'>> = {};

  // 1. Fetch provider → get apiUrl
  try {
    const provider = await getProvider(lease.providerUuid);
    if (provider?.apiUrl) {
      updates.providerUrl = provider.apiUrl;
    }
  } catch (error) {
    logError('leaseDiscovery.enrichSingleLease.getProvider', error);
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
      logError('leaseDiscovery.enrichSingleLease.getSKU', error);
    }
  }

  // 3. If signArbitrary is available, fetch releases and connection info
  let authToken: string | undefined;
  if (signArbitrary && updates.providerUrl) {
    try {
      authToken = await getAuthToken(address, lease.uuid, signArbitrary);

      const [releasesResult, connectionResult] = await Promise.allSettled([
        getLeaseReleases(updates.providerUrl, lease.uuid, authToken),
        getLeaseConnectionInfo(updates.providerUrl, lease.uuid, authToken),
      ]);

      // Extract name and manifest from latest release
      if (releasesResult.status === 'fulfilled' && releasesResult.value.releases.length > 0) {
        const latestRelease = releasesResult.value.releases[releasesResult.value.releases.length - 1];
        if (latestRelease.image) {
          let name = deriveAppNameFromImage(latestRelease.image);
          name = uniquifyName(name, address);
          // Also check against names claimed by concurrent enrichments in this batch
          while (claimedNames.has(name)) {
            name = uniquifyName(name, address);
          }
          claimedNames.add(name);
          updates.name = name;
        }
        if (latestRelease.manifest) {
          try {
            const parsed = JSON.parse(latestRelease.manifest);
            updates.manifest = sanitizeManifestForStorage(JSON.stringify(parsed, null, 2));
          } catch {
            // Invalid manifest JSON — skip
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
          services: conn.services as Record<string, unknown> | undefined,
        };
      }
    } catch (error) {
      logError('leaseDiscovery.enrichSingleLease.fredFetch', error);
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
      logError('leaseDiscovery.enrichSingleLease.getLeaseInfo', error);
    }
  }

  // Apply updates if we got anything
  if (Object.keys(updates).length > 0) {
    updateApp(address, lease.uuid, updates);
  }
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
  // Filter out leases already being enriched
  const toEnrich = leaseUuids.filter((uuid) => {
    if (enrichmentInFlight.has(uuid)) return false;
    enrichmentInFlight.add(uuid);
    return true;
  });

  if (toEnrich.length === 0) return;

  try {
    // Track names claimed during this enrichment run to prevent duplicates
    // across concurrent enrichments within the same batch.
    const claimedNames = new Set<string>();

    // Process in batches of LEASE_DISCOVERY_MAX_CONCURRENT
    for (let i = 0; i < toEnrich.length; i += LEASE_DISCOVERY_MAX_CONCURRENT) {
      const batch = toEnrich.slice(i, i + LEASE_DISCOVERY_MAX_CONCURRENT);
      await Promise.allSettled(
        batch.map((uuid) => {
          const lease = leaseMap.get(uuid);
          if (!lease) return Promise.resolve();
          return enrichSingleLease(address, lease, signArbitrary, claimedNames);
        })
      );
    }
  } finally {
    // Clean up in-flight tracking
    for (const uuid of toEnrich) {
      enrichmentInFlight.delete(uuid);
    }
  }
}

/** Visible for testing — reset the enrichment guard. */
export function _resetEnrichmentInFlight(): void {
  enrichmentInFlight.clear();
}
