/**
 * Composite query tool executors.
 * These run immediately without confirmation.
 */

import type { CosmosClientManager } from '@manifest-network/manifest-sdk';
import { cosmosQuery } from '@manifest-network/manifest-sdk/chain';
import type { ManifestReadClient } from '@manifest-network/manifest-sdk';
import { getReadClient } from '../../api/readClient';
import {
  getLeasesByTenant,
  getLeasesByTenantPaginated,
  getLease,
  LeaseState,
  LEASE_STATE_MAP,
  type LeaseItem,
} from '../../api/billing';
import { getProviders, getSKUs, Unit } from '../../api/sku';
import { getProviderHealth } from '../../api/provider-api';
import { getLeaseLogs, getLeaseProvision, getLeaseReleases } from '../../api/fred';
import {
  appStatus,
  describeFredFailure,
  type FredLeaseStatus,
  type ConnectionDetails,
  type ProviderHealthResponse,
} from '@manifest-network/manifest-sdk/deploy';
import { classifyProvisionStatus, isUnsettledProvisionStatus } from './provisionStatus';
import { buildBarneyCtx } from './capabilityCtx';
import { nextStepFor } from './failureGuidance';
import { formatConnectionUrl, extractPrimaryServicePorts } from './helpers';
import { resolveExpectedCnameTarget } from '../../utils/connection';
import { getDomainAssignments } from '../../api/leaseDomains';
import { requestFaucet } from '@manifest-network/manifest-sdk/faucet';
import { isFaucetEnabled, getFaucetBaseUrl, FAUCET_COOLDOWN_HOURS } from '../../api/faucet';
import { DENOMS, getDenomMetadata, UNIT_LABELS } from '../../api/config';
import { LEASE_STATE_LABELS } from '../../utils/leaseState';
import { fromBaseUnits, parseJsonStringArray } from '../../utils/format';
import { logError } from '../../utils/errors';
import {
  sanitizeForDisplay,
  CHECK_NAME_CHARS,
  CHECK_MESSAGE_CHARS,
  MAX_HEALTH_ERROR_CHARS,
  HEALTH_STATUS_CHARS,
  MAX_REPORTED_CHECKS,
} from '../../utils/sanitizeText';
import { withRetry, withTimeout, throwIfAborted } from '../../api/utils';
import { asLeaseUuid } from '@manifest-network/manifest-sdk';
import type { ToolResult, ToolExecutorOptions, ToolData } from './types';
import type { MessageCard } from '../../contexts/aiTypes';
import type { AppEntry } from '../../registry/appRegistry';

/**
 * Execute list_apps: Get apps from registry, reconcile with chain.
 */
export async function executeListApps(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry, signal } = options;
  throwIfAborted(signal, 'list_apps');
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const stateFilter = (args.state as string | undefined)?.toLowerCase() || 'running';

  // Get apps from registry
  let apps = appRegistry.getApps(address);

  // Re-observe the chain for EVERY app, in both directions. Writing only the
  // NEGATIVE observation ('absent') makes this a latch — state that can go down
  // and never back up. The old asymmetry existed because `updateApp` notified
  // unconditionally, so re-asserting 'active' on a 15s cadence re-rendered the
  // sidebar every tick; it now no-ops when nothing moved, so the re-assert is free.
  //
  // The two lease sets stay SEPARATE rather than unioned: collapsing them makes
  // 'pending' unrecordable, and a PENDING lease derives to 'deploying', not
  // 'running'. 'active' is written last so it wins a uuid in both sets — the same
  // precedence `AppsSidebar.refresh` uses for `reconcileWithChain`.
  try {
    const activeLeases = await withTimeout(getLeasesByTenant(address, LeaseState.LEASE_STATE_ACTIVE), undefined, 'Fetch active leases', signal);
    throwIfAborted(signal, 'list_apps');
    const pendingLeases = await withTimeout(getLeasesByTenant(address, LeaseState.LEASE_STATE_PENDING), undefined, 'Fetch pending leases', signal);
    const leaseStates = new Map<string, 'active' | 'pending'>();
    for (const l of pendingLeases) leaseStates.set(l.uuid, 'pending');
    for (const l of activeLeases) leaseStates.set(l.uuid, 'active');

    for (const app of apps) {
      // A lease in neither live set was observed GONE — 'absent' is a real
      // reading, not a missing one. Read the derived status back rather than
      // asserting one here, so the in-memory copy this response is built from
      // matches what was persisted — including when a provider `failed` verdict
      // outranks the chain observation.
      const chainState = leaseStates.get(app.leaseUuid) ?? 'absent';
      const updated = appRegistry.updateApp(address, app.leaseUuid, { chainState });
      if (updated) app.status = updated.status;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    logError('compositeQueries.executeListApps.reconcile', error);
  }

  // Filter by state
  if (stateFilter !== 'all') {
    apps = apps.filter((a) => a.status === stateFilter);
  }

  const data: ToolData<'list_apps'> = {
    apps: apps.map((a) => {
      let image: string | undefined;
      if (a.manifest) {
        try {
          const manifest = JSON.parse(a.manifest);
          if (typeof manifest.image === 'string') {
            image = manifest.image;
          } else if (manifest.services && typeof manifest.services === 'object') {
            // Stack: join service images (e.g. "nginx + postgres")
            const images = Object.values(manifest.services as Record<string, Record<string, unknown>>)
              .map((svc) => typeof svc.image === 'string' ? svc.image : null)
              .filter(Boolean);
            if (images.length > 0) image = images.join(' + ');
          }
        } catch (error) {
          logError('compositeQueries.executeListApps.parseManifest', error);
        }
      }
      return {
        name: a.name,
        status: a.status,
        size: a.size,
        image,
        url: a.url,
        created: new Date(a.createdAt).toISOString(),
      };
    }),
    count: apps.length,
  };
  return { success: true, data };
}

/**
 * Execute app_status: Registry lookup + chain state + fred status.
 * Reconciles registry with current chain/fred state.
 */
export async function executeAppStatus(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry, signing, signal } = options;
  throwIfAborted(signal, 'app_status');
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  const app = appRegistry.findApp(address, name);
  if (!app) return { success: false, error: `No unique app found matching "${name}"` };

  // Chain state + fred status. ENG-312 Phase 5: the SDK's appStatus primitive
  // does the whole read in one call — chain lease (state + items), provider-URL
  // resolution, ADR-036 status token, fred lease-status + connection info —
  // swallowing provider/fred errors into optional result fields. It needs a
  // signer (providerAuth) + a client manager; when either is absent we fall
  // back to a chain-only read (custom-domain surfacing still works without a
  // provider round-trip).
  let chainState = 'unknown';
  let leaseState: LeaseState | null = null;
  let leaseItems: LeaseItem[] = [];
  let haveChainData = false;
  let fredStatus: FredLeaseStatus | null = null;
  let refreshedConnection: ConnectionDetails | undefined;

  if (signing && options.clientManager) {
    try {
      const ctx = await buildBarneyCtx(options.clientManager, signing);
      throwIfAborted(signal, 'app_status');
      const st = await appStatus(ctx, { address, leaseUuid: app.leaseUuid });
      throwIfAborted(signal, 'app_status');
      leaseState = st.chainState.state as LeaseState;
      chainState = LEASE_STATE_LABELS[leaseState]?.toLowerCase() ?? 'unknown';
      leaseItems = st.chainState.items;
      haveChainData = true;
      fredStatus = st.fredStatus ?? null;
      refreshedConnection = st.connection;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      // appStatus throws (QUERY_FAILED) when the lease is absent on chain, and
      // on transient query failures; either way leave chainState 'unknown' so
      // no reconcile fires — matching the prior getLease-returned-null path.
      logError('compositeQueries.executeAppStatus.appStatus', error);
    }
  } else {
    // No signer / client manager: chain-only read for state + items.
    try {
      const lease = await getLease(app.leaseUuid);
      throwIfAborted(signal, 'app_status');
      if (lease) {
        leaseState = lease.state as LeaseState;
        chainState = LEASE_STATE_LABELS[leaseState]?.toLowerCase() ?? 'unknown';
        leaseItems = lease.items ?? [];
        haveChainData = true;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      logError('compositeQueries.executeAppStatus.chainState', error);
    }
  }

  // Reconcile registry status with chain/fred state.
  //
  // Every branch below records the OBSERVATION it actually made — the chain
  // reading as `chainState`, fred's as `provisionState` — and adopts the summary
  // the registry DERIVES from it rather than asserting one locally. That is what
  // lets the two sources disagree without either clobbering the other.
  let currentStatus = app.status;
  let appUrl = app.url;
  let appConnection = app.connection;

  /** Write an observation and adopt the status the registry derives from it. */
  const recordObservation = (updates: Partial<Omit<AppEntry, 'leaseUuid'>>): void => {
    const updated = appRegistry.updateApp(address, app.leaseUuid, updates);
    if (updated) currentStatus = updated.status;
  };

  // Chain says closed/rejected/expired: the lease is gone. A pure CHAIN
  // observation — it says nothing about why, so it leaves `provisionState` alone.
  if (leaseState === LeaseState.LEASE_STATE_CLOSED || leaseState === LeaseState.LEASE_STATE_REJECTED || leaseState === LeaseState.LEASE_STATE_EXPIRED) {
    if (app.chainState !== 'absent') {
      recordObservation({ chainState: 'absent' });
    }
  }
  // If chain says active, reconcile with fred (or trust chain if fred unavailable)
  else if (leaseState === LeaseState.LEASE_STATE_ACTIVE) {
    if (fredStatus) {
      if (fredStatus.state === LeaseState.LEASE_STATE_ACTIVE) {
        // Connection details were fetched by appStatus alongside the status
        // read (its own errors already swallowed → refreshedConnection undefined).
        let connectionRefreshed = false;
        if (refreshedConnection) {
          const conn = refreshedConnection;
          // Stack deployments: extract primary service ports/fqdn when no top-level values
          if (!conn.ports && !conn.instances?.[0]?.ports && conn.services) {
            const primary = extractPrimaryServicePorts(conn.services);
            if (primary) {
              // Promote primary service's FQDN to top-level for formatConnectionUrl
              let fqdn = conn.fqdn;
              if (!fqdn) {
                const svc = conn.services[primary.serviceName];
                fqdn = svc?.fqdn ?? svc?.instances?.[0]?.fqdn;
              }
              appConnection = JSON.parse(JSON.stringify({ ...conn, ports: primary.ports, fqdn }));
            } else {
              appConnection = JSON.parse(JSON.stringify(conn));
            }
          } else {
            appConnection = JSON.parse(JSON.stringify(conn));
          }
          if (conn.host) {
            appUrl = conn.host;
          }
          connectionRefreshed = true;
        }
        // TWO independent observations: the chain says the lease is ACTIVE, fred's
        // `provision_status` says whatever it says. Recording both is what makes
        // "the lease exists" and "the workload is up" separately expressible.
        const observed = classifyProvisionStatus(fredStatus.provision_status);
        // A reading with NO verdict fills a gap but must not RETRACT a
        // confirmation: 'restarting' on a healthy app would drop it out of every
        // tool that refuses a 'deploying' entry. A failure verdict is never
        // suppressed — the predicate excludes them, which is why `failing`
        // (container died) lands on a confirmed app.
        const unsettled = isUnsettledProvisionStatus(fredStatus.provision_status);
        const provisionState = unsettled && app.provisionState === 'confirmed' ? undefined : observed;
        const observationChanged =
          app.chainState !== 'active' ||
          (provisionState !== undefined && app.provisionState !== provisionState);
        if (observationChanged || connectionRefreshed) {
          recordObservation({
            chainState: 'active',
            ...(provisionState !== undefined ? { provisionState } : {}),
            ...(connectionRefreshed ? { url: appUrl, connection: appConnection } : {}),
          });
        }
      } else if (fredStatus.state === LeaseState.LEASE_STATE_CLOSED || fredStatus.state === LeaseState.LEASE_STATE_REJECTED || fredStatus.state === LeaseState.LEASE_STATE_EXPIRED) {
        // The chain says ACTIVE but the PROVIDER says this lease is terminal —
        // fred v0.13.0's explicitly-modelled anomaly (an ACTIVE lease whose
        // workload is gone). A provider statement about a provider-side lease is
        // a provisioning verdict, so it lands in `provisionState`, where it
        // survives the next reconcile pass.
        if (app.provisionState !== 'failed') {
          recordObservation({ provisionState: 'failed' });
        }
      }
    } else if (app.chainState !== 'active') {
      // Fred unavailable but chain says active — trust the chain, and ONLY the
      // chain: no provider evidence here, so `provisionState` is untouched. A
      // flat `status: 'running'` would silently erase a provider `failed` verdict
      // every time fred happened to be unreachable.
      recordObservation({ chainState: 'active' });
    }
  }
  // Chain says PENDING: the lease exists but carries no workload yet. Recorded
  // here as `executeListApps` and `reconcileWithChain` already do, so a
  // previously-'running' entry does not survive a lease that went back to
  // PENDING. Both the signer and chain-only reads land on `leaseState`, so this
  // one branch covers both.
  else if (leaseState === LeaseState.LEASE_STATE_PENDING) {
    if (app.chainState !== 'pending') {
      recordObservation({ chainState: 'pending' });
    }
  }

  // Build a bare connection endpoint from host + port mappings
  const connectionUrl = formatConnectionUrl(appUrl, appConnection);

  // Extract image from stored manifest (single-service or stack)
  let image: string | undefined;
  let serviceImages: Record<string, string> | undefined;
  if (app.manifest) {
    try {
      const manifest = JSON.parse(app.manifest);
      if (typeof manifest.image === 'string') {
        image = manifest.image;
      } else if (manifest.services && typeof manifest.services === 'object') {
        serviceImages = {};
        for (const [svcName, svcConfig] of Object.entries(manifest.services as Record<string, Record<string, unknown>>)) {
          if (typeof svcConfig.image === 'string') serviceImages[svcName] = svcConfig.image;
        }
        const imgs = Object.values(serviceImages);
        if (imgs.length > 0) image = imgs.join(' + ');
      }
    } catch (error) {
      logError('compositeQueries.executeAppStatus.parseManifest', error);
    }
  }

  // Surface custom domains from chain (single seam — see leaseDomains.ts) and
  // refresh the AppEntry cache so the DNS polling driver (mounted in MainLayout) knows what to watch
  // without an extra chain round-trip per render.
  const customDomains = getDomainAssignments(leaseItems);
  if (haveChainData) {
    appRegistry.updateApp(address, app.leaseUuid, { customDomains });
  }

  // Stack service names — drive the empty-form service picker on stacks where no
  // domain is set yet, and feed the multi-domain consolidated view when multiple
  // domains are attached.
  const stackServiceNames: string[] = serviceImages ? Object.keys(serviceImages) : [];

  // Compute displayCard:
  //  - >=2 custom domains: consolidated multi-domain view
  //  - exactly one custom domain: single-domain status view
  //  - no domain on a running app: "no domain" form (with picker on stacks)
  //  - stopped apps with no domains: skip (not actionable)
  let displayCard: MessageCard | undefined;
  if (customDomains.length >= 2) {
    displayCard = {
      type: 'custom_domain',
      data: {
        appName: app.name,
        fqdn: '',
        leaseUuid: app.leaseUuid,
        serviceName: '',
        expectedAddress: address,
        domains: customDomains.map(({ serviceName, customDomain }) => ({
          serviceName,
          customDomain,
          expectedCnameTarget: resolveExpectedCnameTarget(appConnection, serviceName),
        })),
        ...(stackServiceNames.length > 0 ? { serviceNames: stackServiceNames } : {}),
      },
    };
  } else if (customDomains.length === 1) {
    const { serviceName, customDomain } = customDomains[0];
    displayCard = {
      type: 'custom_domain',
      data: {
        appName: app.name,
        fqdn: customDomain,
        leaseUuid: app.leaseUuid,
        serviceName,
        expectedCnameTarget: resolveExpectedCnameTarget(appConnection, serviceName),
        expectedAddress: address,
        ...(stackServiceNames.length > 0 ? { serviceNames: stackServiceNames } : {}),
      },
    };
  } else if (customDomains.length === 0 && currentStatus === 'running') {
    // Gate on chain LeaseItem service names, not the stored manifest. The
    // manifest-derived `stackServiceNames` would let pre-ENG-56 legacy stacks
    // (all-unnamed chain items but a stored manifest claiming named services)
    // reach the no-domain form — the user would happily fill it in, then
    // `executeSetCustomDomain` rejects at TX time with "predates per-service
    // domains". This gate mirrors the chain truth table in
    // `executeSetCustomDomain` (compositeTransactions.ts):
    //   - single-item (any name shape): attach allowed, auto-pick the lone item
    //   - multi-item with ≥1 named: attach allowed, picker shows named only
    //   - multi-item, all unnamed: chain rejects → don't show form
    const namedServiceNames = leaseItems
      .filter((i) => i.serviceName !== '')
      .map((i) => i.serviceName);
    const canAttachDomain = leaseItems.length === 1 || namedServiceNames.length > 0;
    if (canAttachDomain) {
      const serviceName = leaseItems.length === 1 ? leaseItems[0].serviceName : '';
      displayCard = {
        type: 'custom_domain',
        data: {
          appName: app.name,
          fqdn: '',
          leaseUuid: app.leaseUuid,
          serviceName,
          expectedCnameTarget: resolveExpectedCnameTarget(appConnection, serviceName),
          expectedAddress: address,
          ...(namedServiceNames.length > 0 ? { serviceNames: namedServiceNames } : {}),
        },
      };
    }
  }

  const data: ToolData<'app_status'> = {
    name: app.name,
    status: currentStatus,
    size: app.size,
    image,
    ...(serviceImages ? { serviceImages } : {}),
    url: connectionUrl || appUrl,
    chainState,
    created: new Date(app.createdAt).toISOString(),
    ...(customDomains.length > 0 ? { customDomains } : {}),
  };
  return {
    success: true,
    data,
    ...(displayCard ? { displayCard } : {}),
  };
}

/**
 * Execute get_balance (v2): Simplified balance view with credits, burn rate, time remaining.
 */
export async function executeGetBalance(
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, clientManager, signal } = options;
  throwIfAborted(signal, 'get_balance');
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!clientManager) return { success: false, error: 'Not connected to blockchain' };

  let balance: Awaited<ReturnType<ManifestReadClient['getBalance']>>;
  try {
    const client = await getReadClient();
    balance = await withTimeout(client.getBalance(address), undefined, 'Fetch balance', signal);
  } catch (error) {
    logError('compositeQueries.executeGetBalance', error);
    return {
      success: false,
      error: `Failed to fetch balance: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }

  // Credit balance: PWR denom from balance.credits.balances
  let credits = 0;
  if (balance.credits?.balances) {
    for (const bal of balance.credits.balances) {
      if (bal.denom === DENOMS.PWR || bal.denom.includes('upwr')) {
        credits = fromBaseUnits(bal.amount, bal.denom);
        break;
      }
    }
  }

  // Burn rate: balance.spending_per_hour is already per-hour; aggregate across denoms
  let spendingPerHour = 0;
  if (balance.spending_per_hour) {
    for (const rate of balance.spending_per_hour) {
      spendingPerHour += fromBaseUnits(rate.amount, rate.denom);
    }
  }

  const runningApps = balance.running_apps ? Number(balance.running_apps) : 0;

  // Time remaining: only meaningful when credits are actively being spent
  let hoursRemaining: number | null = null;
  if (spendingPerHour > 0 && balance.hours_remaining) {
    const hours = parseFloat(balance.hours_remaining);
    if (Number.isFinite(hours) && hours > 0) {
      hoursRemaining = Math.floor(hours);
    }
  }

  const data: ToolData<'get_balance'> = {
    credits,
    spending_per_hour: Math.round(spendingPerHour * 100) / 100,
    hours_remaining: hoursRemaining,
    running_apps: runningApps,
  };
  return { success: true, data };
}

/**
 * Order failing health checks so the `MAX_REPORTED_CHECKS` cap can never drop a
 * distinct one. Ported from mono `packages/fred/src/tools/browseCatalog.ts`.
 *
 * Fred marshals `checks` with Go's `encoding/json`, which SORTS map keys, and
 * `JSON.parse` preserves that order — so `backend:docker-N` leads and the
 * singletons (`chain`, `payload_store`, `placement_store`, `token_tracker`)
 * trail. A head-of-list cap would keep only the `backend:*` prefix and silently
 * drop every singleton probe, including `payload_store` — the pre-flight tell
 * that `update_app` will 5xx on this provider. So the singletons, bounded at four
 * and each meaning something different, go FIRST; `backend:*` is the unbounded,
 * repetitive family, and the residual count after the cap covers the rest.
 */
function byDiagnosticValue([a]: [string, unknown], [b]: [string, unknown]): number {
  const backendA = a.startsWith('backend:') ? 1 : 0;
  const backendB = b.startsWith('backend:') ? 1 : 0;
  if (backendA !== backendB) return backendA - backendB;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Render a non-`healthy` verdict into an actionable one-liner (ENG-711).
 *
 * fred v0.13.0 made `/health` a liveness contract: every tier answers 200 and the
 * verdict lives in the body, so projecting it away leaves a bare `healthy: false`
 * with no attribution. Only FAILING checks are named — a passing probe is noise.
 * Keys and messages still go through `sanitizeForDisplay`: they are
 * provider-controlled and land in model-facing prose on a SUCCESS response, which
 * no error-path cap would ever see.
 */
function summarizeFailedChecks(health: ProviderHealthResponse): string {
  const failed = Object.entries(health.checks ?? {})
    .filter(([, c]) => c?.status !== 'healthy')
    .sort(byDiagnosticValue);
  const verdict = sanitizeForDisplay(health.status, HEALTH_STATUS_CHARS);
  if (failed.length === 0) {
    // The provider says something is wrong without saying what. Report the
    // verdict rather than invent a cause.
    return `Provider reports status "${verdict}"`;
  }
  const shown = failed
    .slice(0, MAX_REPORTED_CHECKS)
    .map(([name, c]) => {
      const label = sanitizeForDisplay(name, CHECK_NAME_CHARS);
      return c?.message ? `${label} (${sanitizeForDisplay(c.message, CHECK_MESSAGE_CHARS)})` : label;
    })
    .join(', ');
  const omitted = failed.length - Math.min(failed.length, MAX_REPORTED_CHECKS);
  // Capped again as a whole: the per-field caps bound each piece, this bounds the sum.
  return sanitizeForDisplay(
    `Provider reports status "${verdict}"; failing checks: ${shown}${omitted > 0 ? `, and ${omitted} more` : ''}`,
    MAX_HEALTH_ERROR_CHARS
  );
}

/**
 * Execute browse_catalog: Providers + SKUs grouped by tier.
 */
export async function executeBrowseCatalog(
  options: ToolExecutorOptions = { clientManager: null, address: undefined, tiers: [] },
): Promise<ToolResult> {
  const { signal } = options;
  throwIfAborted(signal, 'browse_catalog');
  const [providers, skus] = await Promise.all([
    withTimeout(getProviders(true), undefined, 'Fetch providers', signal),
    withTimeout(getSKUs(true), undefined, 'Fetch SKUs', signal),
  ]);
  throwIfAborted(signal, 'browse_catalog');

  // Check provider health in parallel.
  //
  // ENG-711: fred v0.13.0 serves /health as a three-tier verdict in the BODY
  // (200 for every tier). `healthy` deliberately stays an exact match on the one
  // verdict that means "fully serving" — a chain-impaired `degraded` fails every
  // lease-resolving endpoint — but the diagnosis is no longer discarded: the raw
  // verdict rides along as `health_status`, the failing checks as `healthError`.
  //
  // The tier set is OPEN. Echo it; never switch on it or branch on a specific
  // value — a tier fred adds tomorrow must pass through verbatim.
  const providersWithHealth = await Promise.all(
    providers.map(async (p) => {
      let healthy = false;
      // Distinguishable from every provider-reported tier, so "we never got an
      // answer" cannot serialize identically to "the provider said no".
      let healthStatus = 'no_api_url';
      let healthError: string | undefined;
      if (p.apiUrl) {
        healthStatus = 'unreachable';
        try {
          const health = await withTimeout(getProviderHealth(p.apiUrl), undefined, `Provider health (${p.uuid})`, signal);
          if (health) {
            healthStatus = sanitizeForDisplay(health.status, HEALTH_STATUS_CHARS);
            healthy = health.status === 'healthy';
            if (!healthy) healthError = summarizeFailedChecks(health);
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          logError(`compositeQueries.executeBrowseCatalog.healthCheck[${p.uuid}]`, error);
        }
      }
      return {
        uuid: p.uuid,
        apiUrl: p.apiUrl,
        healthy,
        health_status: healthStatus,
        ...(healthError !== undefined && { healthError }),
      };
    })
  );
  throwIfAborted(signal, 'browse_catalog');

  // Group SKUs by name (tier)
  const tiers: Record<string, Array<{ provider: string; price: string; unit: string }>> = {};
  for (const sku of skus) {
    const tierName = sku.name;
    if (!tiers[tierName]) tiers[tierName] = [];

    const provider = providersWithHealth.find((p) => p.uuid === sku.providerUuid);
    // Use SKU's unit field for correct display (e.g., /hr, /day)
    const unitLabel = UNIT_LABELS[sku.unit as Unit] || '';
    const priceDisplay = sku.basePrice
      ? `${fromBaseUnits(sku.basePrice.amount, sku.basePrice.denom)} ${getDenomMetadata(sku.basePrice.denom).symbol}${unitLabel}`
      : 'unknown';

    tiers[tierName].push({
      provider: provider?.uuid ?? sku.providerUuid,
      price: priceDisplay,
      unit: sku.unit != null ? String(sku.unit) : 'unknown',
    });
  }

  const data: ToolData<'browse_catalog'> = {
    providers: providersWithHealth,
    tiers,
  };
  return { success: true, data };
}

/** Allowed module+subcommand pairs for the cosmos_query escape hatch. */
const ALLOWED_QUERY_COMMANDS: Record<string, Set<string>> = {
  bank: new Set(['balances', 'balance', 'total-supply', 'denom-metadata', 'params']),
  billing: new Set(['leases', 'lease', 'credit-accounts', 'credit-account', 'params']),
  sku: new Set(['skus', 'sku', 'params']),
  provider: new Set(['providers', 'provider', 'params']),
  staking: new Set(['validators', 'delegation', 'delegations', 'params']),
  gov: new Set(['proposals', 'proposal', 'params']),
  auth: new Set(['account', 'accounts', 'params']),
};

/**
 * Execute cosmos_query (pass-through to MCP).
 * Restricted to an allowlist of safe module+subcommand pairs.
 */
export async function executeCosmosQuery(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager | null
): Promise<ToolResult> {
  if (!clientManager) {
    return { success: false, error: 'Not connected to blockchain' };
  }

  const module = args.module;
  const subcommand = args.subcommand;
  if (typeof module !== 'string' || !module) {
    return { success: false, error: 'module is required' };
  }
  if (typeof subcommand !== 'string' || !subcommand) {
    return { success: false, error: 'subcommand is required' };
  }

  const allowedSubs = ALLOWED_QUERY_COMMANDS[module];
  if (!allowedSubs || !allowedSubs.has(subcommand)) {
    const allowed = Object.entries(ALLOWED_QUERY_COMMANDS)
      .map(([m, subs]) => `${m}: ${[...subs].join(', ')}`)
      .join('; ');
    return { success: false, error: `"${module} ${subcommand}" is not allowed. Allowed queries: ${allowed}` };
  }

  const parseResult = parseJsonStringArray(args.args);
  if (parseResult.error) {
    return { success: false, error: parseResult.error };
  }

  const result = await cosmosQuery(clientManager, module, subcommand, parseResult.data);
  return { success: true, data: result };
}

/** Max total characters of log text before truncation to avoid bloating LLM context. */
const MAX_LOG_CHARS = 4000;

/**
 * Execute get_logs: Fetch container logs for a running app.
 */
export async function executeGetLogs(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry, signing, signal } = options;
  throwIfAborted(signal, 'get_logs');
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  const app = appRegistry.findApp(address, name);
  if (!app) return { success: false, error: `No unique app found matching "${name}"` };

  // Only 'stopped' refuses, matching `app_diagnostics` and `app_releases`. A
  // 'failed' app is exactly when its logs are wanted, and barney already reads
  // them in that state (`deployError.ts`'s `fetchFailureLogs`) because fred keeps
  // the lease and its containers through a failed provision. 'stopped' still
  // refuses: the lease is gone, so the lease-scoped ADR-036 token has nothing to
  // authenticate against.
  if (app.status === 'stopped') {
    return { success: false, error: `App "${app.name}" is stopped. Logs are not available for stopped apps.` };
  }

  if (!app.providerUrl) {
    return { success: false, error: `App "${app.name}" has no provider URL` };
  }
  if (!signing) {
    return { success: false, error: 'Signing not available' };
  }

  const tail = typeof args.tail === 'number' && args.tail > 0 ? Math.floor(args.tail) : 100;

  let authToken: string;
  try {
    authToken = await signing.authTokens.getAuthToken(asLeaseUuid(app.leaseUuid));
  } catch (error) {
    logError('compositeQueries.executeGetLogs.sign', error);
    return {
      success: false,
      error: `Failed to sign request: ${error instanceof Error ? error.message : 'Unknown signing error'}`,
    };
  }

  let logsResponse;
  try {
    logsResponse = await getLeaseLogs(app.providerUrl, app.leaseUuid, authToken, tail);
  } catch (error) {
    logError('compositeQueries.executeGetLogs', error);
    return {
      success: false,
      error: `Failed to fetch logs for "${app.name}": ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }

  // Full logs for the UI display card
  const fullLogs = logsResponse.logs;

  // Truncated logs for the LLM context (avoid bloating the conversation)
  const llmLogs: Record<string, string> = {};
  let totalChars = 0;
  let truncated = false;
  for (const [service, text] of Object.entries(fullLogs)) {
    if (totalChars >= MAX_LOG_CHARS) {
      truncated = true;
      break;
    }
    const remaining = MAX_LOG_CHARS - totalChars;
    if (text.length > remaining) {
      llmLogs[service] = text.slice(text.length - remaining);
      totalChars += remaining;
      truncated = true;
    } else {
      llmLogs[service] = text;
      totalChars += text.length;
    }
  }

  const data: ToolData<'get_logs'> = {
    app_name: app.name,
    logs: llmLogs,
    truncated,
  };
  return {
    success: true,
    data,
    displayCard: {
      type: 'logs',
      data: {
        app_name: app.name,
        logs: fullLogs,
        truncated: false,
      },
    },
  };
}

/**
 * Execute lease_history: Paginated on-chain lease history.
 */
export async function executeLeaseHistory(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry, signal } = options;
  throwIfAborted(signal, 'lease_history');
  if (!address) return { success: false, error: 'Wallet not connected' };

  const stateArg = (args.state as string | undefined)?.toLowerCase() || 'all';
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
  const offset = Math.max(Number(args.offset) || 0, 0);

  const stateFilter = stateArg === 'all'
    ? LeaseState.LEASE_STATE_UNSPECIFIED
    : LEASE_STATE_MAP[stateArg];
  if (stateFilter === undefined) {
    return { success: false, error: `Invalid state "${stateArg}". Valid: all, pending, active, closed, rejected, expired.` };
  }

  const result = await getLeasesByTenantPaginated(address, { stateFilter, limit, offset, reverse: true });

  const leases = result.leases.map((lease) => {
    const app = appRegistry?.getAppByLease(address, lease.uuid);
    return {
      uuid: lease.uuid,
      name: app?.name,
      state: LEASE_STATE_LABELS[lease.state as LeaseState] || 'unknown',
      created: lease.createdAt ? new Date(lease.createdAt).toISOString() : undefined,
      closed: lease.closedAt ? new Date(lease.closedAt).toISOString() : undefined,
      closureReason: lease.closureReason || undefined,
      rejectionReason: lease.rejectionReason || undefined,
    };
  });

  const total = result.pagination?.total ? Number(result.pagination.total) : undefined;

  return {
    success: true,
    data: {
      leases,
      count: leases.length,
      total,
      offset,
      limit,
      hasMore: total !== undefined ? offset + leases.length < total : leases.length === limit,
    },
  };
}

/**
 * Caps on the provider-controlled failure fields echoed by app_diagnostics,
 * matching mono's own `sanitizeFailureFields`. `message` gets the longer cap
 * because the 64-code-point default bisects fred's composed rollback suffixes.
 */
const DIAGNOSTIC_REASON_CHARS = 64;
const DIAGNOSTIC_MESSAGE_CHARS = 256;

/**
 * Execute app_diagnostics: Fetch provision status for an app.
 */
export async function executeAppDiagnostics(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry, signing, signal } = options;
  throwIfAborted(signal, 'app_diagnostics');
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  const app = appRegistry.findApp(address, name);
  if (!app) return { success: false, error: `No unique app found matching "${name}"` };

  // Only 'stopped' refuses: a failed app is precisely when diagnostics are wanted,
  // and an update that came back indeterminate points the model here on an entry
  // barney may have marked failed.
  if (app.status === 'stopped') {
    return { success: false, error: `App "${app.name}" is stopped. Diagnostics are not available for stopped apps.` };
  }

  if (!app.providerUrl) {
    return { success: false, error: `App "${app.name}" has no provider URL` };
  }
  if (!signing) {
    return { success: false, error: 'Signing not available' };
  }

  let authToken: string;
  try {
    authToken = await signing.authTokens.getAuthToken(asLeaseUuid(app.leaseUuid));
  } catch (error) {
    logError('compositeQueries.executeAppDiagnostics.sign', error);
    return {
      success: false,
      error: `Failed to sign request: ${error instanceof Error ? error.message : 'Unknown signing error'}`,
    };
  }

  try {
    const provision = await getLeaseProvision(app.providerUrl, app.leaseUuid, authToken);
    // fred v0.13.0 replaced `last_error` with a curated `reason` + `message`
    // pair. Providers upgrade independently of barney, so BOTH eras are live at
    // once — `describeFredFailure` prefers reason/message and falls back to
    // last_error, which is still echoed when the provider sent it. `nextStepFor`
    // is barney's remapper, not the SDK's `guidanceFor` (see failureGuidance.ts);
    // its `undefined` is the NORMAL case for a reason from a newer fred, and the
    // set is open, so nothing here gates on the value.
    const failure = describeFredFailure(provision);
    const nextStep = nextStepFor(provision.reason, app.name);
    return {
      success: true,
      data: {
        app_name: app.name,
        status: provision.status,
        fail_count: provision.fail_count,
        ...(failure?.reason !== undefined && { reason: sanitizeForDisplay(failure.reason, DIAGNOSTIC_REASON_CHARS) }),
        ...(failure?.message !== undefined && { message: sanitizeForDisplay(failure.message, DIAGNOSTIC_MESSAGE_CHARS) }),
        ...(provision.last_error !== undefined && { last_error: sanitizeForDisplay(provision.last_error, DIAGNOSTIC_MESSAGE_CHARS) }),
        ...(nextStep !== undefined && { next_step: nextStep }),
      },
    };
  } catch (error) {
    logError('compositeQueries.executeAppDiagnostics', error);
    return {
      success: false,
      error: `Failed to fetch diagnostics for "${app.name}": ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Execute app_releases: Fetch release history for an app.
 */
export async function executeAppReleases(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry, signing, signal } = options;
  throwIfAborted(signal, 'app_releases');
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  const app = appRegistry.findApp(address, name);
  if (!app) return { success: false, error: `No unique app found matching "${name}"` };

  // See executeAppDiagnostics: a failed app still has a release history, and that
  // history is what tells the user which version the provider is actually running.
  if (app.status === 'stopped') {
    return { success: false, error: `App "${app.name}" is stopped. Releases are not available for stopped apps.` };
  }

  if (!app.providerUrl) {
    return { success: false, error: `App "${app.name}" has no provider URL` };
  }
  if (!signing) {
    return { success: false, error: 'Signing not available' };
  }

  let authToken: string;
  try {
    authToken = await signing.authTokens.getAuthToken(asLeaseUuid(app.leaseUuid));
  } catch (error) {
    logError('compositeQueries.executeAppReleases.sign', error);
    return {
      success: false,
      error: `Failed to sign request: ${error instanceof Error ? error.message : 'Unknown signing error'}`,
    };
  }

  try {
    const releasesResponse = await getLeaseReleases(app.providerUrl, app.leaseUuid, authToken);
    return {
      success: true,
      data: {
        app_name: app.name,
        releases: releasesResponse.releases,
        count: releasesResponse.releases.length,
      },
    };
  } catch (error) {
    logError('compositeQueries.executeAppReleases', error);
    return {
      success: false,
      error: `Failed to fetch releases for "${app.name}": ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Execute request_faucet: Request available tokens from the faucet.
 * Discovers denoms automatically via the faucet /status endpoint.
 */
export async function executeRequestFaucet(
  options: ToolExecutorOptions
): Promise<ToolResult> {
  if (!isFaucetEnabled()) return { success: false, error: 'Faucet is not available on this network' };
  const { address, signal } = options;
  throwIfAborted(signal, 'request_faucet');
  if (!address) return { success: false, error: 'Wallet not connected' };

  let faucetResult;
  try {
    faucetResult = await withRetry(
      () => requestFaucet(getFaucetBaseUrl(), address),
      { context: 'faucet.requestFaucet', maxRetries: 1 }
    );
  } catch (error) {
    logError('compositeQueries.executeRequestFaucet', error);
    return {
      success: false,
      error: 'Faucet is temporarily unavailable. Please try again in a few minutes.',
    };
  }
  const { results } = faucetResult;

  const allSuccess = results.every((r) => r.success);
  const allFailed = results.every((r) => !r.success);

  if (allSuccess) {
    return {
      success: true,
      data: {
        message: 'Tokens sent! You received PWR (gas + credits) and MFX.',
        results,
      },
    };
  }

  if (allFailed) {
    return {
      success: false,
      error: `Faucet request failed for all tokens. ${FAUCET_COOLDOWN_HOURS}-hour cooldown may be active. Details: ${results.map((r) => `${r.denom}: ${r.error}`).join('; ')}`,
    };
  }

  // Partial success
  const succeeded = results.filter((r) => r.success).map((r) => r.denom);
  const failed = results.filter((r) => !r.success);
  return {
    success: true,
    data: {
      message: `Partial success: received ${succeeded.join(', ')}. Failed: ${failed.map((r) => `${r.denom} (${r.error})`).join(', ')}. ${FAUCET_COOLDOWN_HOURS}-hour cooldown may be active for failed tokens.`,
      results,
    },
  };
}
