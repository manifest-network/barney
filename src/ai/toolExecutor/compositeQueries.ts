/**
 * Composite query tool executors.
 * These run immediately without confirmation.
 */

import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import { cosmosQuery } from '@manifest-network/manifest-mcp-browser';
import {
  getLeasesByTenant,
  getCreditAccount,
  getCreditEstimate,
  getLease,
  LeaseState,
} from '../../api/billing';
import { getAllBalances } from '../../api/bank';
import { getProviders, getSKUs, Unit } from '../../api/sku';
import { getProviderHealth } from '../../api/provider-api';
import { getLeaseStatus } from '../../api/fred';
import { createSignMessage, createAuthToken } from '../../api/provider-api';
import { DENOMS, getDenomMetadata, UNIT_LABELS } from '../../api/config';
import { fromBaseUnits, parseJsonStringArray } from '../../utils/format';
import { logError } from '../../utils/errors';
import { withTimeout } from '../../api/utils';
import type { ToolResult, ToolExecutorOptions, SignResult } from './types';

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
      apps: apps.map((a) => ({
        name: a.name,
        status: a.status,
        size: a.size,
        url: a.url,
        created: new Date(a.createdAt).toISOString(),
      })),
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

  const app = appRegistry.getApp(address, name);
  if (!app) return { success: false, error: `No app found named "${name}"` };

  // Get chain state
  let chainState = 'unknown';
  let leaseState: number | null = null;
  try {
    const lease = await getLease(app.leaseUuid);
    if (lease) {
      leaseState = lease.state as number;
      // Map numeric state to string
      const stateMap: Record<number, string> = {
        0: 'unspecified', 1: 'pending', 2: 'active', 3: 'closed', 4: 'rejected', 5: 'expired',
      };
      chainState = stateMap[leaseState] ?? 'unknown';
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
      const timestamp = Math.floor(Date.now() / 1000);
      const signMessage = createSignMessage(address, app.leaseUuid, timestamp);
      const signResult: SignResult = await signArbitrary(address, signMessage);
      const authToken = createAuthToken(
        address,
        app.leaseUuid,
        timestamp,
        signResult.pub_key.value,
        signResult.signature
      );
      fredStatus = await getLeaseStatus(app.providerUrl, app.leaseUuid, authToken);
    } catch (error) {
      logError('compositeQueries.executeAppStatus.fredStatus', error);
    }
  }

  // Reconcile registry status with chain/fred state
  let currentStatus = app.status;
  let appUrl = app.url;

  // If chain says closed/rejected/expired, mark as stopped
  if (leaseState === 3 || leaseState === 4 || leaseState === 5) {
    if (app.status !== 'stopped' && app.status !== 'failed') {
      currentStatus = 'stopped';
      appRegistry.updateApp(address, app.leaseUuid, { status: 'stopped' });
    }
  }
  // If chain says active and fred says ready/active, mark as running
  else if (leaseState === 2 && fredStatus) {
    if (fredStatus.status === 'ready' || fredStatus.status === 'active') {
      if (app.status !== 'running') {
        currentStatus = 'running';
        appUrl = fredStatus.endpoints ? Object.values(fredStatus.endpoints)[0] : app.url;
        appRegistry.updateApp(address, app.leaseUuid, { status: 'running', url: appUrl });
      }
    } else if (fredStatus.status === 'failed') {
      if (app.status !== 'failed') {
        currentStatus = 'failed';
        appRegistry.updateApp(address, app.leaseUuid, { status: 'failed' });
      }
    }
  }

  return {
    success: true,
    data: {
      name: app.name,
      status: currentStatus,
      size: app.size,
      url: appUrl,
      chainState,
      fredStatus,
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
      spendingPerHour += perSecond * 3600;
    }
  }

  // Time remaining
  let hoursRemaining: number | null = null;
  if (estimate?.estimatedDurationSeconds) {
    hoursRemaining = Math.floor(Number(estimate.estimatedDurationSeconds) / 3600);
  }

  // Running app count
  const runningApps = estimate?.activeLeaseCount ? Number(estimate.activeLeaseCount) : 0;

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
        } catch {
          // offline
        }
      }
      return {
        uuid: p.uuid,
        name: p.name,
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
      provider: provider?.name ?? sku.providerUuid,
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

/**
 * Execute cosmos_query (pass-through to MCP).
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

  const parseResult = parseJsonStringArray(args.args);
  if (parseResult.error) {
    return { success: false, error: parseResult.error };
  }

  const result = await cosmosQuery(clientManager, module, subcommand, parseResult.data);
  return { success: true, data: result };
}
