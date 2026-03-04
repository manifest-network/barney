/**
 * Composite query tool executors.
 * These run immediately without confirmation.
 */

import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import { cosmosQuery } from '@manifest-network/manifest-mcp-browser';
import {
  getLeasesByTenant,
  getLeasesByTenantPaginated,
  getCreditAccount,
  getCreditEstimate,
  getLease,
  LeaseState,
  LEASE_STATE_MAP,
} from '../../api/billing';
import { getAllBalances } from '../../api/bank';
import { getProviders, getSKUs, Unit } from '../../api/sku';
import { getProviderHealth, getLeaseConnectionInfo } from '../../api/provider-api';
import { getLeaseStatus, getLeaseLogs, getLeaseProvision, getLeaseReleases } from '../../api/fred';
import { formatConnectionUrl, extractPrimaryServicePorts } from './helpers';
import { requestFaucetTokens, isFaucetEnabled, FAUCET_COOLDOWN_HOURS } from '../../api/faucet';
import { DENOMS, getDenomMetadata, UNIT_LABELS } from '../../api/config';
import { LEASE_STATE_LABELS } from '../../utils/leaseState';
import { fromBaseUnits, parseJsonStringArray } from '../../utils/format';
import { logError } from '../../utils/errors';
import { withTimeout } from '../../api/utils';
import { SECONDS_PER_HOUR } from '../../config/constants';
import { getProviderAuthToken } from './utils';
import type { ToolResult, ToolExecutorOptions } from './types';

/**
 * Execute list_apps: Get apps from registry, reconcile with chain.
 */
export async function executeListApps(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const stateFilter = (args.state as string | undefined)?.toLowerCase() || 'running';

  // Get apps from registry
  let apps = appRegistry.getApps(address);

  // Reconcile with chain: mark apps as stopped if lease is gone
  try {
    const activeLeases = await withTimeout(getLeasesByTenant(address, LeaseState.LEASE_STATE_ACTIVE), undefined, 'Fetch active leases');
    const pendingLeases = await withTimeout(getLeasesByTenant(address, LeaseState.LEASE_STATE_PENDING), undefined, 'Fetch pending leases');
    const activeUuids = new Set([
      ...activeLeases.map((l) => l.uuid),
      ...pendingLeases.map((l) => l.uuid),
    ]);

    for (const app of apps) {
      if (
        (app.status === 'running' || app.status === 'deploying') &&
        !activeUuids.has(app.leaseUuid)
      ) {
        appRegistry.updateApp(address, app.leaseUuid, { status: 'stopped' });
        app.status = 'stopped';
      }
    }
  } catch (error) {
    logError('compositeQueries.executeListApps.reconcile', error);
  }

  // Filter by state
  if (stateFilter !== 'all') {
    apps = apps.filter((a) => a.status === stateFilter);
  }

  return {
    success: true,
    data: {
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
    },
  };
}

/**
 * Execute app_status: Registry lookup + chain state + fred status.
 * Reconciles registry with current chain/fred state.
 */
export async function executeAppStatus(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry, signArbitrary } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  const app = appRegistry.findApp(address, name);
  if (!app) return { success: false, error: `No unique app found matching "${name}"` };

  // Get chain state
  let chainState = 'unknown';
  let leaseState: LeaseState | null = null;
  try {
    const lease = await getLease(app.leaseUuid);
    if (lease) {
      leaseState = lease.state as LeaseState;
      chainState = LEASE_STATE_LABELS[leaseState]?.toLowerCase() ?? 'unknown';
    }
  } catch (error) {
    logError('compositeQueries.executeAppStatus.chainState', error);
  }

  // Get fred status if app could be active
  let fredStatus = null;
  if (
    (app.status === 'running' || app.status === 'deploying') &&
    app.providerUrl &&
    signArbitrary
  ) {
    try {
      const authToken = await getProviderAuthToken(address, app.leaseUuid, signArbitrary);
      fredStatus = await getLeaseStatus(app.providerUrl, app.leaseUuid, authToken);
    } catch (error) {
      logError('compositeQueries.executeAppStatus.fredStatus', error);
    }
  }

  // Reconcile registry status with chain/fred state
  let currentStatus = app.status;
  let appUrl = app.url;
  let appConnection = app.connection;

  // If chain says closed/rejected/expired, mark as stopped
  if (leaseState === LeaseState.LEASE_STATE_CLOSED || leaseState === LeaseState.LEASE_STATE_REJECTED || leaseState === LeaseState.LEASE_STATE_EXPIRED) {
    if (app.status !== 'stopped' && app.status !== 'failed') {
      currentStatus = 'stopped';
      appRegistry.updateApp(address, app.leaseUuid, { status: 'stopped' });
    }
  }
  // If chain says active, reconcile with fred (or trust chain if fred unavailable)
  else if (leaseState === LeaseState.LEASE_STATE_ACTIVE) {
    if (fredStatus) {
      if (fredStatus.state === LeaseState.LEASE_STATE_ACTIVE) {
        if (app.status !== 'running') {
          currentStatus = 'running';
        }
        // Fetch connection details from provider API
        let connectionRefreshed = false;
        if (signArbitrary && app.providerUrl) {
          try {
            const infoAuthToken = await getProviderAuthToken(address, app.leaseUuid, signArbitrary);
            const connResponse = await getLeaseConnectionInfo(app.providerUrl, app.leaseUuid, infoAuthToken);
            if (connResponse.connection) {
              const conn = connResponse.connection;
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
                  appConnection = { ...conn, ports: primary.ports, fqdn };
                } else {
                  appConnection = conn;
                }
              } else {
                appConnection = conn;
              }
              if (conn.host) {
                appUrl = conn.host;
              }
              connectionRefreshed = true;
            }
          } catch (error) {
            logError('compositeQueries.executeAppStatus.connection', error);
          }
        }
        if (app.status !== 'running' || connectionRefreshed) {
          appRegistry.updateApp(address, app.leaseUuid, {
            status: 'running',
            ...(connectionRefreshed ? { url: appUrl, connection: appConnection } : {}),
          });
        }
      } else if (fredStatus.state === LeaseState.LEASE_STATE_CLOSED || fredStatus.state === LeaseState.LEASE_STATE_REJECTED || fredStatus.state === LeaseState.LEASE_STATE_EXPIRED) {
        if (app.status !== 'failed') {
          currentStatus = 'failed';
          appRegistry.updateApp(address, app.leaseUuid, { status: 'failed' });
        }
      }
    } else if (app.status !== 'running') {
      // Fred unavailable but chain says active — trust the chain
      currentStatus = 'running';
      appRegistry.updateApp(address, app.leaseUuid, { status: 'running' });
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

  return {
    success: true,
    data: {
      name: app.name,
      status: currentStatus,
      size: app.size,
      image,
      ...(serviceImages ? { serviceImages } : {}),
      url: connectionUrl || appUrl,
      chainState,
      created: new Date(app.createdAt).toISOString(),
    },
  };
}

/**
 * Execute get_balance (v2): Simplified balance view with credits, burn rate, time remaining.
 */
export async function executeGetBalance(
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };

  const [balances, creditAccount, estimate] = await Promise.all([
    withTimeout(getAllBalances(address), undefined, 'Fetch balances'),
    withTimeout(getCreditAccount(address), undefined, 'Fetch credit account').catch((error) => {
      logError('compositeQueries.executeGetBalance.creditAccount', error);
      return null;
    }),
    withTimeout(getCreditEstimate(address), undefined, 'Fetch credit estimate').catch((error) => {
      logError('compositeQueries.executeGetBalance.creditEstimate', error);
      return null;
    }),
  ]);

  // Format credit balance (look for PWR in credit account balances)
  let credits = 0;
  if (creditAccount?.balances) {
    for (const bal of creditAccount.balances) {
      if (bal.denom === DENOMS.PWR || bal.denom.includes('upwr')) {
        credits = fromBaseUnits(bal.amount, bal.denom);
        break;
      }
    }
  }

  // Format burn rate
  let spendingPerHour = 0;
  if (estimate?.totalRatePerSecond) {
    for (const rate of estimate.totalRatePerSecond) {
      const perSecond = fromBaseUnits(rate.amount, rate.denom);
      spendingPerHour += perSecond * SECONDS_PER_HOUR;
    }
  }

  // Running app count
  const runningApps = estimate?.activeLeaseCount ? Number(estimate.activeLeaseCount) : 0;

  // Time remaining (only meaningful when credits are actively being spent)
  let hoursRemaining: number | null = null;
  if (spendingPerHour > 0 && estimate?.estimatedDurationSeconds) {
    hoursRemaining = Math.floor(Number(estimate.estimatedDurationSeconds) / SECONDS_PER_HOUR);
  }

  // Wallet MFX balance
  let mfxBalance = 0;
  for (const bal of balances) {
    if (bal.denom === DENOMS.MFX) {
      mfxBalance = fromBaseUnits(bal.amount, bal.denom);
      break;
    }
  }

  return {
    success: true,
    data: {
      credits,
      spending_per_hour: Math.round(spendingPerHour * 100) / 100,
      hours_remaining: hoursRemaining,
      running_apps: runningApps,
      mfx_balance: mfxBalance,
    },
  };
}

/**
 * Execute browse_catalog: Providers + SKUs grouped by tier.
 */
export async function executeBrowseCatalog(): Promise<ToolResult> {
  const [providers, skus] = await Promise.all([
    withTimeout(getProviders(true), undefined, 'Fetch providers'),
    withTimeout(getSKUs(true), undefined, 'Fetch SKUs'),
  ]);

  // Check provider health in parallel
  const providersWithHealth = await Promise.all(
    providers.map(async (p) => {
      let healthy = false;
      if (p.apiUrl) {
        try {
          const health = await getProviderHealth(p.apiUrl);
          healthy = health?.status === 'healthy';
        } catch (error) {
          logError(`compositeQueries.executeBrowseCatalog.healthCheck[${p.uuid}]`, error);
        }
      }
      return {
        uuid: p.uuid,
        apiUrl: p.apiUrl,
        healthy,
      };
    })
  );

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

  return {
    success: true,
    data: {
      providers: providersWithHealth,
      tiers,
    },
  };
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
  const { address, appRegistry, signArbitrary } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  const app = appRegistry.findApp(address, name);
  if (!app) return { success: false, error: `No unique app found matching "${name}"` };

  if (app.status === 'stopped' || app.status === 'failed') {
    return { success: false, error: `App "${app.name}" is ${app.status}. Logs are not available for stopped or failed apps.` };
  }

  if (!app.providerUrl) {
    return { success: false, error: `App "${app.name}" has no provider URL` };
  }
  if (!signArbitrary) {
    return { success: false, error: 'Signing not available' };
  }

  const tail = typeof args.tail === 'number' && args.tail > 0 ? Math.floor(args.tail) : 100;

  let authToken: string;
  try {
    authToken = await getProviderAuthToken(address, app.leaseUuid, signArbitrary);
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

  return {
    success: true,
    data: {
      app_name: app.name,
      logs: llmLogs,
      truncated,
    },
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
  const { address, appRegistry } = options;
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
 * Execute app_diagnostics: Fetch provision status for an app.
 */
export async function executeAppDiagnostics(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry, signArbitrary } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  const app = appRegistry.findApp(address, name);
  if (!app) return { success: false, error: `No unique app found matching "${name}"` };

  if (app.status === 'stopped' || app.status === 'failed') {
    return { success: false, error: `App "${app.name}" is ${app.status}. Diagnostics are not available for stopped or failed apps.` };
  }

  if (!app.providerUrl) {
    return { success: false, error: `App "${app.name}" has no provider URL` };
  }
  if (!signArbitrary) {
    return { success: false, error: 'Signing not available' };
  }

  let authToken: string;
  try {
    authToken = await getProviderAuthToken(address, app.leaseUuid, signArbitrary);
  } catch (error) {
    logError('compositeQueries.executeAppDiagnostics.sign', error);
    return {
      success: false,
      error: `Failed to sign request: ${error instanceof Error ? error.message : 'Unknown signing error'}`,
    };
  }

  try {
    const provision = await getLeaseProvision(app.providerUrl, app.leaseUuid, authToken);
    return {
      success: true,
      data: {
        app_name: app.name,
        status: provision.status,
        fail_count: provision.fail_count,
        last_error: provision.last_error,
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
  const { address, appRegistry, signArbitrary } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  const app = appRegistry.findApp(address, name);
  if (!app) return { success: false, error: `No unique app found matching "${name}"` };

  if (app.status === 'stopped' || app.status === 'failed') {
    return { success: false, error: `App "${app.name}" is ${app.status}. Releases are not available for stopped or failed apps.` };
  }

  if (!app.providerUrl) {
    return { success: false, error: `App "${app.name}" has no provider URL` };
  }
  if (!signArbitrary) {
    return { success: false, error: 'Signing not available' };
  }

  let authToken: string;
  try {
    authToken = await getProviderAuthToken(address, app.leaseUuid, signArbitrary);
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
 * Execute request_faucet: Request MFX and PWR tokens from the faucet.
 */
export async function executeRequestFaucet(
  options: ToolExecutorOptions
): Promise<ToolResult> {
  if (!isFaucetEnabled()) return { success: false, error: 'Faucet is not available on this network' };
  const { address } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };

  const { results } = await requestFaucetTokens(address);

  const allSuccess = results.every((r) => r.success);
  const allFailed = results.every((r) => !r.success);

  if (allSuccess) {
    return {
      success: true,
      data: {
        message: 'Tokens sent! You received MFX (for gas) and PWR (for credits).',
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
