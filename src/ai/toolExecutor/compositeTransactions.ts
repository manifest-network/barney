/**
 * Composite transaction tool executors.
 * These return requiresConfirmation first, then execute after user approval.
 */

import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import { cosmosTx } from '@manifest-network/manifest-mcp-browser';
import { getCreditEstimate } from '../../api/billing';
import { getProviders, getSKUs } from '../../api/sku';
import { createSignMessage, createAuthToken } from '../../api/provider-api';
import { pollLeaseUntilReady } from '../../api/fred';
import { DENOMS, getDenomMetadata } from '../../api/config';
import { fromBaseUnits, parseJsonStringArray } from '../../utils/format';
import { logError } from '../../utils/errors';
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
    return { success: false, error: 'No file attached. Please attach a manifest file (e.g., docker-compose.yml) to deploy an app.' };
  }

  // Resolve name
  let name = args.name as string | undefined;
  if (!name && payload.filename) {
    name = deriveAppName(payload.filename);
  }
  if (!name) {
    name = `app-${Date.now().toString(36)}`;
  }

  // Validate name
  const nameError = validateAppName(name, address);
  if (nameError) {
    return { success: false, error: nameError };
  }

  // Resolve size
  const size = (args.size as string | undefined)?.toLowerCase() || 'small';
  const skuName = `docker-${size}`;

  // Find matching SKU
  let allSKUs;
  try {
    allSKUs = await getSKUs(true);
  } catch {
    return { success: false, error: 'Failed to fetch available tiers. Please try again.' };
  }

  const resolveResult = resolveSkuItems(
    [{ sku_name: skuName, quantity: 1 }],
    allSKUs
  );
  if (resolveResult.error) {
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
    providers = await getProviders(true);
  } catch {
    return { success: false, error: 'Failed to fetch providers. Please try again.' };
  }

  const provider = matchingSku
    ? providers.find((p) => p.uuid === matchingSku.providerUuid)
    : providers[0];

  if (!provider || !provider.apiUrl) {
    return { success: false, error: 'No available provider found for this tier.' };
  }

  // Check credits
  let creditWarning = '';
  try {
    const estimate = await getCreditEstimate(address);
    if (estimate) {
      const hoursRemaining = Math.floor(Number(estimate.estimatedDurationSeconds) / 3600);
      if (hoursRemaining < 1) {
        return {
          success: false,
          error: 'Insufficient credits. You have less than 1 hour of runway. Use fund_credits to add more credits before deploying.',
        };
      }
      if (hoursRemaining < 24) {
        creditWarning = ` Warning: only ~${hoursRemaining}h of credits remaining.`;
      }
    }
  } catch (error) {
    logError('compositeTransactions.executeDeployApp.creditCheck', error);
  }

  // Format price for confirmation
  let priceDisplay = '';
  if (matchingSku?.price) {
    const { symbol } = getDenomMetadata(matchingSku.price.denom);
    const displayPrice = fromBaseUnits(matchingSku.price.amount, matchingSku.price.denom);
    priceDisplay = ` (~${displayPrice} ${symbol}/hr)`;
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Deploy "${name}" on ${size} tier${priceDisplay}?${creditWarning}`,
    pendingAction: {
      toolName: 'deploy_app',
      args: {
        name,
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

  const name = args.name as string;
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

    const fredStatus = await pollLeaseUntilReady(providerUrl, leaseUuid, authToken, {
      onProgress: (status) => {
        onProgress?.({
          phase: 'provisioning',
          detail: status.phase || 'Provisioning...',
          fredStatus: status,
        });
      },
    });

    if (fredStatus.status === 'ready') {
      const appUrl = fredStatus.endpoints
        ? Object.values(fredStatus.endpoints)[0]
        : undefined;

      appRegistry.updateApp(address, leaseUuid, {
        status: 'running',
        url: appUrl,
      });
      onProgress?.({ phase: 'ready', detail: 'App is live!' });

      return {
        success: true,
        data: {
          message: `App "${name}" is live!`,
          name,
          url: appUrl,
          status: 'running',
        },
      };
    }

    if (fredStatus.status === 'failed') {
      appRegistry.updateApp(address, leaseUuid, { status: 'failed' });
      onProgress?.({ phase: 'failed', detail: fredStatus.error || 'Deployment failed' });
      return {
        success: false,
        error: `Deployment failed: ${fredStatus.error || 'Unknown error'}. The lease is active — use stop_app("${name}") to clean up.`,
      };
    }

    // Timeout (still provisioning)
    appRegistry.updateApp(address, leaseUuid, { status: 'deploying' });
    return {
      success: true,
      data: {
        message: `App "${name}" is still deploying. Use app_status("${name}") to check progress.`,
        name,
        status: 'deploying',
      },
    };
  } catch (error) {
    logError('compositeTransactions.executeConfirmedDeployApp.polling', error);
    // Polling failed but lease+upload succeeded
    return {
      success: true,
      data: {
        message: `App "${name}" was deployed but status check failed. Use app_status("${name}") to check.`,
        name,
        status: 'deploying',
      },
    };
  }
}

// ============================================================================
// stop_app
// ============================================================================

/**
 * Pre-validation for stop_app. Returns confirmation result or error.
 */
export async function executeStopApp(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.name as string;
  if (!name) return { success: false, error: 'App name is required' };

  const app = appRegistry.getApp(address, name);
  if (!app) return { success: false, error: `No app found named "${name}"` };

  if (app.status === 'stopped') {
    return { success: false, error: `App "${name}" is already stopped.` };
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Stop app "${name}"? This will terminate the deployment and stop billing.`,
    pendingAction: {
      toolName: 'stop_app',
      args: { name, leaseUuid: app.leaseUuid },
    },
  };
}

/**
 * Execute stop_app after user confirmation.
 */
export async function executeConfirmedStopApp(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.name as string;
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
      name,
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
