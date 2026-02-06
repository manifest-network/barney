/**
 * Composite transaction tool executors.
 * These return requiresConfirmation first, then execute after user approval.
 */

import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import { cosmosTx } from '@manifest-network/manifest-mcp-browser';
import { getCreditAccount, getLease, LeaseState } from '../../api/billing';
import { getProviders, getSKUs, Unit } from '../../api/sku';
import { createSignMessage, createAuthToken, getLeaseConnectionInfo } from '../../api/provider-api';
import { pollLeaseUntilReady, getLeaseLogs, getLeaseProvision, type TerminalChainState } from '../../api/fred';
import { DENOMS, getDenomMetadata, UNIT_LABELS } from '../../api/config';
import { fromBaseUnits, parseJsonStringArray } from '../../utils/format';
import { logError } from '../../utils/errors';
import { withTimeout } from '../../api/utils';
import { AI_DEPLOY_PROVISION_TIMEOUT_MS } from '../../config/constants';
import { extractLeaseUuidFromTxResult, uploadPayloadToProvider } from './utils';
import { resolveSkuItems } from './transactions';
import { validateAppName } from '../../registry/appRegistry';
import type { ToolResult, ToolExecutorOptions, SignResult, PayloadAttachment } from './types';

/**
 * Derive an app name from a filename.
 * Strip extension, lowercase, replace invalid chars with hyphens, truncate to 32.
 */
export function deriveAppName(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '') // strip extension
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-') // replace invalid chars
    .replace(/-+/g, '-') // collapse consecutive hyphens
    .replace(/^-|-$/g, '') // trim leading/trailing hyphens
    .slice(0, 32)
    || 'app';
}

/**
 * Best-effort fetch of provider logs and provision status for failed deploys.
 * Creates a fresh auth token since the original may be stale after long polling.
 * Never throws — failure to get logs must not mask the deploy error.
 */
async function fetchFailureLogs(
  providerUrl: string,
  leaseUuid: string,
  address: string,
  signArbitrary: ToolExecutorOptions['signArbitrary']
): Promise<string | null> {
  if (!signArbitrary) return null;

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const signMessage = createSignMessage(address, leaseUuid, timestamp);
    const signResult: SignResult = await signArbitrary(address, signMessage);
    const authToken = createAuthToken(
      address,
      leaseUuid,
      timestamp,
      signResult.pub_key.value,
      signResult.signature
    );

    const parts: string[] = [];

    // Fetch provision status first — more structured than raw logs
    try {
      const provision = await getLeaseProvision(providerUrl, leaseUuid, authToken);
      if (provision.last_error) {
        parts.push(`Provision error (fail_count=${provision.fail_count}): ${provision.last_error}`);
      }
    } catch (error) {
      logError('compositeTransactions.fetchFailureLogs.provision', error);
    }

    // Fetch container logs
    try {
      const response = await getLeaseLogs(providerUrl, leaseUuid, authToken, 100);
      const logEntries = Object.entries(response.logs ?? {});
      if (logEntries.length > 0) {
        const logText = logEntries
          .map(([service, text]) => `[${service}]\n${typeof text === 'string' ? text : JSON.stringify(text)}`)
          .join('\n');
        parts.push(`Container logs:\n${logText}`);
      }
    } catch (error) {
      logError('compositeTransactions.fetchFailureLogs.logs', error);
    }

    if (parts.length === 0) return null;

    const combined = parts.join('\n\n');
    // Truncate to last ~2000 chars to avoid bloating LLM context
    if (combined.length > 2000) {
      return '...' + combined.slice(-2000);
    }
    return combined;
  } catch (error) {
    logError('compositeTransactions.fetchFailureLogs', error);
    return null;
  }
}

// ============================================================================
// deploy_app
// ============================================================================

/**
 * Pre-validation for deploy_app. Returns confirmation result or error.
 */
export async function executeDeployApp(
  args: Record<string, unknown>,
  options: ToolExecutorOptions,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };
  if (!payload) {
    return { success: false, error: 'No file attached. Please attach a JSON manifest file to deploy an app.' };
  }

  // Resolve name
  let name = args.app_name as string | undefined;
  if (!name && payload.filename) {
    name = deriveAppName(payload.filename);
  }
  if (!name) {
    name = `app-${Date.now().toString(36)}`;
  }

  // Validate name — auto-suffix on collision with running/deploying apps
  let nameError = validateAppName(name, address);
  if (nameError) {
    const baseName = name;
    let suffix = 2;
    while (nameError && suffix <= 99) {
      const candidate = `${baseName}-${suffix}`.slice(0, 32);
      nameError = validateAppName(candidate, address);
      if (!nameError) {
        name = candidate;
      }
      suffix++;
    }
    if (nameError) {
      return { success: false, error: nameError };
    }
  }

  // Resolve and validate size
  const VALID_SIZE_TIERS = ['micro', 'small', 'medium', 'large'] as const;
  const size = (args.size as string | undefined)?.toLowerCase() || 'micro';
  if (!VALID_SIZE_TIERS.includes(size as typeof VALID_SIZE_TIERS[number])) {
    return {
      success: false,
      error: `Invalid size "${size}". Valid tiers: ${VALID_SIZE_TIERS.join(', ')}.`,
    };
  }
  const skuName = `docker-${size}`;

  // Find matching SKU
  let allSKUs;
  try {
    allSKUs = await withTimeout(getSKUs(true), undefined, 'Fetch tiers');
  } catch {
    return { success: false, error: 'Failed to fetch available tiers. Please try again.' };
  }

  const resolveResult = resolveSkuItems(
    [{ sku_name: skuName, quantity: 1 }],
    allSKUs
  );
  if (resolveResult.error || !resolveResult.items) {
    return {
      success: false,
      error: `Tier "${size}" is not available. Use browse_catalog to see available tiers.`,
    };
  }

  const skuUuid = resolveResult.items[0].sku_uuid;

  // Find provider
  const matchingSku = allSKUs.find((s) => s.uuid === skuUuid);
  let providers;
  try {
    providers = await withTimeout(getProviders(true), undefined, 'Fetch providers');
  } catch {
    return { success: false, error: 'Failed to fetch providers. Please try again.' };
  }

  const provider = matchingSku
    ? providers.find((p) => p.uuid === matchingSku.providerUuid)
    : providers[0];

  if (!provider || !provider.apiUrl) {
    return { success: false, error: 'No available provider found for this tier.' };
  }

  // Format price for display using SKU's unit, and calculate hourly cost for credit check
  let priceDisplay = '';
  let skuHourlyCost = 0;
  if (matchingSku?.basePrice) {
    const { symbol } = getDenomMetadata(matchingSku.basePrice.denom);
    const basePrice = fromBaseUnits(matchingSku.basePrice.amount, matchingSku.basePrice.denom);
    const unitLabel = UNIT_LABELS[matchingSku.unit as Unit] || '/hr';

    // Convert to hourly cost based on unit
    if (matchingSku.unit === Unit.UNIT_PER_DAY) {
      skuHourlyCost = basePrice / 24;
    } else {
      // Default to per-hour for UNIT_PER_HOUR or unspecified
      skuHourlyCost = basePrice;
    }

    priceDisplay = `${Math.round(basePrice * 100) / 100} ${symbol}${unitLabel}`;
  }

  // Check credits - verify user can afford at least 1 hour of this SKU
  let creditWarning = '';
  try {
    const creditAccount = await withTimeout(getCreditAccount(address), undefined, 'Credit check');
    if (creditAccount?.balances) {
      // Find PWR balance
      let credits = 0;
      for (const bal of creditAccount.balances) {
        if (bal.denom === DENOMS.PWR || bal.denom.includes('upwr')) {
          credits = fromBaseUnits(bal.amount, bal.denom);
          break;
        }
      }

      // Check if user can afford at least 1 hour of this SKU
      if (skuHourlyCost > 0 && credits < skuHourlyCost) {
        return {
          success: false,
          error: `Insufficient credits. You have ${Math.round(credits * 100) / 100} credits but need at least ${Math.round(skuHourlyCost * 100) / 100} for 1 hour. Selected: ${size} tier on ${provider.uuid} (${priceDisplay}). Use fund_credits to add more credits.`,
        };
      }

      // Warn if less than 24 hours of runway for this SKU
      if (skuHourlyCost > 0) {
        const hoursAffordable = credits / skuHourlyCost;
        if (hoursAffordable < 24) {
          creditWarning = ` Warning: only ~${Math.floor(hoursAffordable)}h of credits remaining at this rate.`;
        }
      }
    }
  } catch (error) {
    logError('compositeTransactions.executeDeployApp.creditCheck', error);
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Deploy "${name}" on ${size} tier${priceDisplay ? ` (~${priceDisplay})` : ''}?${creditWarning}`,
    pendingAction: {
      toolName: 'deploy_app',
      args: {
        app_name: name,
        size,
        skuUuid,
        providerUuid: provider.uuid,
        providerUrl: provider.apiUrl,
      },
    },
  };
}

/**
 * Execute deploy_app after user confirmation.
 */
export async function executeConfirmedDeployApp(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  const { address, appRegistry, signArbitrary, onProgress } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };
  if (!payload) return { success: false, error: 'Payload missing' };
  if (!signArbitrary) return { success: false, error: 'Wallet does not support message signing' };

  const name = args.app_name as string;
  const size = args.size as string;
  const skuUuid = args.skuUuid as string;
  const providerUuid = args.providerUuid as string;
  const providerUrl = args.providerUrl as string;
  const metaHashHex = payload.hash;

  // Create lease
  onProgress?.({ phase: 'creating_lease', detail: 'Creating lease on-chain...' });

  const cmdArgs = ['--meta-hash', metaHashHex, `${skuUuid}:1`];
  const result = await cosmosTx(clientManager, 'billing', 'create-lease', cmdArgs, true);

  if (result.code !== 0) {
    onProgress?.({ phase: 'failed', detail: result.rawLog ?? 'Transaction failed' });
    return { success: false, error: result.rawLog ?? 'Failed to create lease' };
  }

  const leaseUuid = extractLeaseUuidFromTxResult(result);
  if (!leaseUuid) {
    onProgress?.({ phase: 'failed', detail: 'Could not extract lease UUID from transaction' });
    return { success: false, error: 'Lease created but could not extract UUID. Check your leases manually.' };
  }

  // Add to registry
  appRegistry.addApp(address, {
    name,
    leaseUuid,
    size,
    providerUuid,
    providerUrl,
    createdAt: Date.now(),
    status: 'deploying',
  });

  // Upload payload
  onProgress?.({ phase: 'uploading', detail: 'Uploading manifest to provider...' });

  const uploadResult = await uploadPayloadToProvider(
    providerUrl,
    leaseUuid,
    metaHashHex,
    payload.bytes,
    address,
    signArbitrary
  );

  if (!uploadResult.success) {
    onProgress?.({ phase: 'failed', detail: `Upload failed: ${uploadResult.error}` });
    appRegistry.updateApp(address, leaseUuid, { status: 'failed' });
    return {
      success: false,
      error: `Lease created but upload failed: ${uploadResult.error}. The lease ${leaseUuid} is active — you may need to stop it.`,
    };
  }

  // Poll fred for readiness
  onProgress?.({ phase: 'provisioning', detail: 'Waiting for deployment...' });

  try {
    const getAuthToken = async (): Promise<string> => {
      const ts = Math.floor(Date.now() / 1000);
      const msg = createSignMessage(address, leaseUuid, ts);
      const sig: SignResult = await signArbitrary(address, msg);
      return createAuthToken(address, leaseUuid, ts, sig.pub_key.value, sig.signature);
    };

    const authToken = await getAuthToken();

    const POLL_INTERVAL_MS = 3000;
    const fredStatus = await pollLeaseUntilReady(providerUrl, leaseUuid, authToken, {
      maxAttempts: Math.ceil(AI_DEPLOY_PROVISION_TIMEOUT_MS / POLL_INTERVAL_MS),
      intervalMs: POLL_INTERVAL_MS,
      onProgress: (status) => {
        onProgress?.({
          phase: 'provisioning',
          detail: status.phase || 'Provisioning...',
          fredStatus: status,
        });
      },
      getAuthToken,
      // Check chain state to detect rejected/closed leases
      checkChainState: async (): Promise<TerminalChainState | null> => {
        const lease = await getLease(leaseUuid);
        if (!lease) return { state: 'closed' };
        if (lease.state === LeaseState.LEASE_STATE_CLOSED) return { state: 'closed' };
        if (lease.state === LeaseState.LEASE_STATE_REJECTED) return { state: 'rejected' };
        if (lease.state === LeaseState.LEASE_STATE_EXPIRED) return { state: 'expired' };
        return null;
      },
    });

    if (fredStatus.state === LeaseState.LEASE_STATE_ACTIVE) {
      // Fetch connection details from provider API
      let appUrl: string | undefined;
      let connection: { host: string; ports?: Record<string, { host_ip: string; host_port: number }> } | undefined;
      try {
        const infoTimestamp = Math.floor(Date.now() / 1000);
        const infoSignMessage = createSignMessage(address, leaseUuid, infoTimestamp);
        const infoSignResult: SignResult = await signArbitrary(address, infoSignMessage);
        const infoAuthToken = createAuthToken(
          address,
          leaseUuid,
          infoTimestamp,
          infoSignResult.pub_key.value,
          infoSignResult.signature
        );
        const connResponse = await getLeaseConnectionInfo(providerUrl, leaseUuid, infoAuthToken);
        if (connResponse.connection) {
          connection = connResponse.connection;
          if (connResponse.connection.host) {
            appUrl = connResponse.connection.host;
          }
        }
      } catch (error) {
        logError('compositeTransactions.executeConfirmedDeployApp.connection', error);
      }

      // Build a clickable connection URL from host + first port mapping
      let connectionUrl = appUrl;
      if (connection?.ports) {
        const firstPort = Object.values(connection.ports)[0];
        if (firstPort) {
          const host = firstPort.host_ip || connection.host || appUrl;
          connectionUrl = `${host}:${firstPort.host_port}`;
        }
      }

      appRegistry.updateApp(address, leaseUuid, {
        status: 'running',
        url: appUrl,
        connection,
      });
      onProgress?.({ phase: 'ready', detail: 'App is live!' });

      return {
        success: true,
        data: {
          message: `App "${name}" is live!`,
          name,
          url: connectionUrl || appUrl,
          connection,
          status: 'running',
        },
      };
    }

    if (fredStatus.state === LeaseState.LEASE_STATE_CLOSED || fredStatus.state === LeaseState.LEASE_STATE_REJECTED || fredStatus.state === LeaseState.LEASE_STATE_EXPIRED) {
      appRegistry.updateApp(address, leaseUuid, { status: 'failed' });
      onProgress?.({ phase: 'failed', detail: fredStatus.error || 'Deployment failed' });

      const diagnostics = await fetchFailureLogs(providerUrl, leaseUuid, address, signArbitrary);
      const errorMsg = diagnostics
        ? `Deployment failed: ${fredStatus.error || 'Unknown error'}\n\n${diagnostics}`
        : `Deployment failed: ${fredStatus.error || 'Unknown error'}`;

      return {
        success: false,
        error: errorMsg,
      };
    }

    // Fred didn't confirm — fall back to chain state
    return await fallbackToChainState(name, leaseUuid, appRegistry, address, onProgress);
  } catch (error) {
    logError('compositeTransactions.executeConfirmedDeployApp.polling', error);
    // Polling failed but lease+upload succeeded — check chain state to determine actual status.
    // Don't use diagnostics alone to decide failure: they may describe a still-running app.
    return await fallbackToChainState(name, leaseUuid, appRegistry, address, onProgress);
  }
}

/**
 * When fred polling doesn't confirm readiness, check the chain state.
 * If the lease is ACTIVE on chain, trust it and mark the app as running.
 */
async function fallbackToChainState(
  name: string,
  leaseUuid: string,
  appRegistry: ToolExecutorOptions['appRegistry'],
  address: string,
  onProgress?: ToolExecutorOptions['onProgress'],
): Promise<ToolResult> {
  try {
    const lease = await getLease(leaseUuid);
    if (lease && lease.state === LeaseState.LEASE_STATE_ACTIVE) {
      // Chain says ACTIVE — trust it
      appRegistry?.updateApp(address, leaseUuid, { status: 'running' });
      onProgress?.({ phase: 'ready', detail: 'App is live!' });
      return {
        success: true,
        data: {
          message: `App "${name}" is live!`,
          name,
          status: 'running',
        },
      };
    }
  } catch (error) {
    logError('compositeTransactions.fallbackToChainState', error);
  }

  // Chain state unknown or not active — keep as deploying
  appRegistry?.updateApp(address, leaseUuid, { status: 'deploying' });
  onProgress?.({ phase: 'failed', detail: `Provisioning timed out. Use app_status("${name}") to check progress.` });
  return {
    success: true,
    data: {
      message: `App "${name}" is still deploying. Use app_status("${name}") to check progress.`,
      name,
      status: 'deploying',
    },
  };
}

// ============================================================================
// stop_app
// ============================================================================

/**
 * Pre-validation for stop_app. Returns confirmation result or error.
 * Supports app_name="all" to stop every running/deploying app at once.
 */
export async function executeStopApp(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  // Bulk stop: gather all running/deploying apps
  if (name.toLowerCase() === 'all') {
    const allApps = appRegistry.getApps(address);
    const active = allApps.filter((a) => a.status === 'running' || a.status === 'deploying');
    if (active.length === 0) {
      return { success: false, error: 'No running apps to stop.' };
    }
    const names = active.map((a) => a.name);
    const entries = active.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid }));
    return {
      success: true,
      requiresConfirmation: true,
      confirmationMessage: `Stop ${active.length} app${active.length > 1 ? 's' : ''} (${names.join(', ')})? This will terminate all deployments and stop billing.`,
      pendingAction: {
        toolName: 'stop_app',
        args: { app_name: 'all', entries },
      },
    };
  }

  const app = appRegistry.getApp(address, name) ?? appRegistry.findApp(address, name);
  if (!app) return { success: false, error: `No app found named "${name}"` };

  if (app.status === 'stopped') {
    return { success: false, error: `App "${app.name}" is already stopped.` };
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Stop app "${app.name}"? This will terminate the deployment and stop billing.`,
    pendingAction: {
      toolName: 'stop_app',
      args: { app_name: app.name, leaseUuid: app.leaseUuid },
    },
  };
}

/**
 * Execute stop_app after user confirmation.
 * Supports bulk stop when args.entries is present (from app_name="all").
 */
export async function executeConfirmedStopApp(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  // Bulk stop
  const entries = args.entries as Array<{ app_name: string; leaseUuid: string }> | undefined;
  if (entries && entries.length > 0) {
    const stopped: string[] = [];
    const failed: string[] = [];

    for (const entry of entries) {
      const result = await cosmosTx(clientManager, 'billing', 'close-lease', [entry.leaseUuid], true);
      if (result.code === 0) {
        appRegistry.updateApp(address, entry.leaseUuid, { status: 'stopped' });
        stopped.push(entry.app_name);
      } else {
        failed.push(entry.app_name);
      }
    }

    if (failed.length > 0 && stopped.length === 0) {
      return { success: false, error: `Failed to stop: ${failed.join(', ')}` };
    }

    const parts: string[] = [];
    if (stopped.length > 0) parts.push(`Stopped: ${stopped.join(', ')}.`);
    if (failed.length > 0) parts.push(`Failed to stop: ${failed.join(', ')}.`);

    return {
      success: true,
      data: {
        message: parts.join(' '),
        stopped,
        failed,
        status: 'stopped',
      },
    };
  }

  // Single stop
  const name = args.app_name as string;
  const leaseUuid = args.leaseUuid as string;

  const result = await cosmosTx(clientManager, 'billing', 'close-lease', [leaseUuid], true);

  if (result.code !== 0) {
    return { success: false, error: result.rawLog ?? 'Failed to stop app' };
  }

  appRegistry.updateApp(address, leaseUuid, { status: 'stopped' });

  return {
    success: true,
    data: {
      message: `App "${name}" has been stopped.`,
      app_name: name,
      status: 'stopped',
    },
  };
}

// ============================================================================
// fund_credits
// ============================================================================

/**
 * Pre-validation for fund_credits. Returns confirmation result or error.
 */
export function executeFundCredits(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): ToolResult {
  const { address } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };

  const amount = args.amount;
  if (typeof amount !== 'number' || amount <= 0 || !Number.isFinite(amount)) {
    return { success: false, error: 'Amount must be a positive number.' };
  }

  const microAmount = Math.floor(amount * 1_000_000);
  const denomString = `${microAmount}${DENOMS.PWR}`;

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Add ${amount} credits to your account?`,
    pendingAction: {
      toolName: 'fund_credits',
      args: { amount, microAmount, denomString, address },
    },
  };
}

/**
 * Execute fund_credits after user confirmation.
 */
export async function executeConfirmedFundCredits(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager
): Promise<ToolResult> {
  const address = args.address as string;
  const denomString = args.denomString as string;
  const amount = args.amount as number;

  const result = await cosmosTx(clientManager, 'billing', 'fund-credit', [address, denomString], true);

  if (result.code !== 0) {
    return { success: false, error: result.rawLog ?? 'Failed to fund credits' };
  }

  return {
    success: true,
    data: {
      message: `Added ${amount} credits to your account.`,
      amount,
      transactionHash: result.transactionHash,
    },
  };
}

// ============================================================================
// cosmos_tx (escape hatch)
// ============================================================================

/**
 * Pre-validation for cosmos_tx. Returns confirmation result or error.
 */
export function executeCosmosTransaction(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): ToolResult {
  const { address } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };

  const module = args.module as string;
  const subcommand = args.subcommand as string;
  if (!module) return { success: false, error: 'module is required' };
  if (!subcommand) return { success: false, error: 'subcommand is required' };

  const parseResult = parseJsonStringArray(args.args);
  if (parseResult.error) {
    return { success: false, error: parseResult.error };
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Execute ${module} ${subcommand}?`,
    pendingAction: {
      toolName: 'cosmos_tx',
      args: { module, subcommand, parsedArgs: parseResult.data },
    },
  };
}

/**
 * Execute cosmos_tx after user confirmation.
 */
export async function executeConfirmedCosmosTx(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager
): Promise<ToolResult> {
  const module = args.module as string;
  const subcommand = args.subcommand as string;
  const parsedArgs = (args.parsedArgs as string[]) ?? [];

  const result = await cosmosTx(clientManager, module, subcommand, parsedArgs, true);

  if (result.code !== 0) {
    return { success: false, error: result.rawLog ?? 'Transaction failed' };
  }

  return {
    success: true,
    data: {
      message: `Executed ${module} ${subcommand}.`,
      transactionHash: result.transactionHash,
    },
  };
}
