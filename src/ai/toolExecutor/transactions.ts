/**
 * Transaction tool handlers (require user confirmation)
 */

import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import { cosmosTx } from '@manifest-network/manifest-mcp-browser';
import { getLease } from '../../api/billing';
import { getProviders } from '../../api/sku';
import { isValidUUID, parseJsonStringArray } from '../../utils/format';
import type { ToolResult, SignResult } from './types';
import { extractLeaseUuidFromTxResult, uploadPayloadToProvider, computePayloadHash } from './utils';

/**
 * Execute a confirmed transaction tool
 */
export async function executeTransaction(
  toolName: string,
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  address?: string,
  signArbitrary?: (address: string, data: string) => Promise<SignResult>
): Promise<ToolResult> {
  switch (toolName) {
    case 'fund_credit': {
      const amount = args.amount as string;
      if (!amount) {
        return { success: false, error: 'amount is required' };
      }
      if (!address) {
        return { success: false, error: 'Wallet not connected' };
      }

      // fund-credit requires: <tenant-address> <amount>
      const result = await cosmosTx(clientManager, 'billing', 'fund-credit', [address, amount], true);
      return {
        success: result.code === 0,
        data: result,
        error: result.code !== 0 ? result.rawLog : undefined,
      };
    }

    case 'create_lease':
      return executeCreateLease(args, clientManager, address, signArbitrary);

    case 'upload_payload':
      return executeUploadPayload(args, address, signArbitrary);

    case 'close_lease': {
      const leaseUuid = args.lease_uuid as string;
      if (!leaseUuid) {
        return { success: false, error: 'lease_uuid is required' };
      }

      const reason = args.reason as string | undefined;
      const txArgs = reason ? ['--reason', reason, leaseUuid] : [leaseUuid];

      const result = await cosmosTx(clientManager, 'billing', 'close-lease', txArgs, true);
      return {
        success: result.code === 0,
        data: result,
        error: result.code !== 0 ? result.rawLog : undefined,
      };
    }

    case 'cosmos_tx': {
      const module = args.module as string;
      const subcommand = args.subcommand as string;

      // Validate args.args is present and valid
      if (!args.args) {
        return { success: false, error: 'Missing required argument: args' };
      }

      const parseResult = parseJsonStringArray(args.args);
      if (parseResult.error) {
        return { success: false, error: parseResult.error };
      }
      const txArgs = parseResult.data;

      const result = await cosmosTx(clientManager, module, subcommand, txArgs, true);
      return {
        success: result.code === 0,
        data: result,
        error: result.code !== 0 ? result.rawLog : undefined,
      };
    }

    default:
      return { success: false, error: `Unknown transaction tool: ${toolName}` };
  }
}

/**
 * Execute create_lease with optional deployment data upload
 */
async function executeCreateLease(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  address?: string,
  signArbitrary?: (address: string, data: string) => Promise<SignResult>
): Promise<ToolResult> {
  if (!address) {
    return { success: false, error: 'Wallet not connected' };
  }

  let items: Array<{ sku_uuid: string; quantity: number }>;

  try {
    items =
      typeof args.items === 'string'
        ? JSON.parse(args.items)
        : (args.items as Array<{ sku_uuid: string; quantity: number }>);
  } catch {
    return { success: false, error: 'Invalid items format' };
  }

  // Validate UUID format - must be proper UUID like "019beb87-09de-7000-beef-ae733e73ff23"
  for (const item of items) {
    if (!isValidUUID(item.sku_uuid)) {
      return {
        success: false,
        error: `Invalid SKU UUID format: "${item.sku_uuid}". SKU UUIDs must be valid UUIDs (e.g., "019beb87-09de-7000-beef-ae733e73ff23"). You must call get_providers and then get_skus to obtain the correct UUID for the SKU the user wants.`,
      };
    }
  }

  const deploymentData = args.deployment_data as string | undefined;
  let metaHashHex: string | undefined;
  let payloadBytes: Uint8Array | undefined;

  // If deployment_data is provided, compute the meta_hash
  if (deploymentData && deploymentData.trim()) {
    // Fail early if signArbitrary is not available - we need it for payload upload
    if (!signArbitrary) {
      return {
        success: false,
        error:
          'Cannot create lease with deployment data: wallet does not support message signing (ADR-036). Please use a wallet that supports signArbitrary, or create the lease without deployment_data.',
      };
    }
    payloadBytes = new TextEncoder().encode(deploymentData);
    metaHashHex = await computePayloadHash(payloadBytes);
  }

  // Format items for the MCP: sku-uuid:quantity format
  const itemArgs = items.map((item) => `${item.sku_uuid}:${item.quantity}`);

  // If meta_hash is set, include it in the create-lease command
  // The MCP supports: create-lease [--meta-hash <hash>] <item1> <item2> ...
  const cmdArgs = metaHashHex ? ['--meta-hash', metaHashHex, ...itemArgs] : itemArgs;

  const result = await cosmosTx(clientManager, 'billing', 'create-lease', cmdArgs, true);

  if (result.code !== 0) {
    return {
      success: false,
      data: result,
      error: result.rawLog,
    };
  }

  // If we have deployment data and lease creation succeeded, upload the payload
  if (deploymentData && metaHashHex && payloadBytes && signArbitrary) {
    return handlePayloadUploadAfterLeaseCreation(
      result as unknown as Record<string, unknown>,
      address,
      metaHashHex,
      payloadBytes,
      signArbitrary
    );
  }

  return {
    success: true,
    data: result,
  };
}

/**
 * Handle payload upload after successful lease creation
 */
async function handlePayloadUploadAfterLeaseCreation(
  result: Record<string, unknown>,
  address: string,
  metaHashHex: string,
  payloadBytes: Uint8Array,
  signArbitrary: (address: string, data: string) => Promise<SignResult>
): Promise<ToolResult> {
  try {
    // Extract lease UUID from the transaction result
    const leaseUuid = extractLeaseUuidFromTxResult(result);

    if (!leaseUuid) {
      return {
        success: true,
        data: {
          ...result,
          warning:
            'Lease created but could not extract UUID for payload upload. You may need to upload payload manually.',
        },
      };
    }

    // Get the provider API URL from the lease
    const leaseData = await getLease(leaseUuid);
    if (!leaseData) {
      return {
        success: true,
        data: {
          ...result,
          leaseUuid,
          warning: 'Lease created but could not fetch lease data for payload upload.',
        },
      };
    }

    const provider = await getProviders(false).then((providers) =>
      providers.find((p) => p.uuid === leaseData.provider_uuid)
    );

    if (!provider || !provider.api_url) {
      return {
        success: true,
        data: {
          ...result,
          leaseUuid,
          warning:
            'Lease created but provider API URL not found. You may need to upload payload manually using upload_payload tool.',
        },
      };
    }

    // Upload the payload
    const uploadResult = await uploadPayloadToProvider(
      provider.api_url,
      leaseUuid,
      metaHashHex,
      payloadBytes,
      address,
      signArbitrary
    );

    if (!uploadResult.success) {
      return {
        success: true,
        data: {
          ...result,
          leaseUuid,
          payloadUploadError: uploadResult.error,
          warning: 'Lease created but payload upload failed. You may need to upload payload manually.',
        },
      };
    }

    return {
      success: true,
      data: {
        ...result,
        leaseUuid,
        payloadUploaded: true,
        message: 'Lease created and deployment data uploaded successfully.',
      },
    };
  } catch (uploadErr) {
    return {
      success: true,
      data: {
        ...result,
        payloadUploadError: uploadErr instanceof Error ? uploadErr.message : 'Unknown error',
        warning: 'Lease created but payload upload failed. You may need to upload payload manually.',
      },
    };
  }
}

/**
 * Execute upload_payload tool
 */
async function executeUploadPayload(
  args: Record<string, unknown>,
  address?: string,
  signArbitrary?: (address: string, data: string) => Promise<SignResult>
): Promise<ToolResult> {
  if (!address) {
    return { success: false, error: 'Wallet not connected' };
  }
  if (!signArbitrary) {
    return { success: false, error: 'Signing not available. Please reconnect your wallet.' };
  }

  const leaseUuid = args.lease_uuid as string;
  const payload = args.payload as string;

  if (!leaseUuid || !payload) {
    return { success: false, error: 'Missing required arguments: lease_uuid and payload are required.' };
  }

  // Get the lease to verify meta_hash and get provider_uuid
  const lease = await getLease(leaseUuid);

  if (!lease) {
    return {
      success: false,
      error: `Lease not found: ${leaseUuid}`,
    };
  }

  if (!lease.meta_hash || lease.meta_hash === '') {
    return {
      success: false,
      error: 'Lease does not have a meta_hash. Payload upload requires a lease created with meta_hash.',
    };
  }

  // SECURITY: Derive provider API URL from on-chain lease data, not from tool args
  // This prevents prompt injection attacks that could redirect auth tokens to attacker endpoints
  const providers = await getProviders(false);
  const provider = providers.find((p) => p.uuid === lease.provider_uuid);

  if (!provider) {
    return {
      success: false,
      error: `Provider not found for lease. Provider UUID: ${lease.provider_uuid}`,
    };
  }

  if (!provider.api_url) {
    return {
      success: false,
      error: `Provider ${provider.uuid} does not have an API URL configured.`,
    };
  }

  const providerApiUrl = provider.api_url;

  // Compute payload hash and verify it matches the lease meta_hash
  const payloadBytes = new TextEncoder().encode(payload);
  const computedHash = await computePayloadHash(payloadBytes);

  // The lease.meta_hash is stored as a string
  const leaseMetaHashHex = lease.meta_hash;

  if (computedHash.toLowerCase() !== leaseMetaHashHex.toLowerCase()) {
    return {
      success: false,
      error: `Payload hash mismatch. Expected: ${leaseMetaHashHex}, Computed: ${computedHash}. The payload must match the hash stored when the lease was created.`,
    };
  }

  return uploadPayloadToProvider(providerApiUrl, leaseUuid, computedHash, payloadBytes, address, signArbitrary);
}
