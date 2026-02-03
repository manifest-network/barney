/**
 * Transaction tool handlers (require user confirmation)
 */

import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import { cosmosTx } from '@manifest-network/manifest-mcp-browser';
import { getLease } from '../../api/billing';
import { getProviders, getSKUs } from '../../api/sku';
import { isValidUUID, parseJsonStringArray } from '../../utils/format';
import type { ToolResult, SignResult, PayloadAttachment } from './types';
import { extractLeaseUuidFromTxResult, uploadPayloadToProvider, computePayloadHash } from './utils';

/**
 * Execute a confirmed transaction tool
 */
export async function executeTransaction(
  toolName: string,
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  address?: string,
  signArbitrary?: (address: string, data: string) => Promise<SignResult>,
  payload?: PayloadAttachment
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
      if (result.code !== 0) {
        return { success: false, error: result.rawLog ?? 'Transaction failed' };
      }
      return {
        success: true,
        data: {
          message: `Successfully funded credit account with ${amount}.`,
          transactionHash: result.transactionHash,
        },
      };
    }

    case 'create_lease':
      return executeCreateLease(args, clientManager, address, signArbitrary, payload);

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
      if (result.code !== 0) {
        return { success: false, error: result.rawLog ?? 'Transaction failed' };
      }
      return {
        success: true,
        data: {
          message: `Successfully closed lease ${leaseUuid}.`,
          leaseUuid,
          transactionHash: result.transactionHash,
        },
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
      if (result.code !== 0) {
        return { success: false, error: result.rawLog ?? 'Transaction failed' };
      }
      return {
        success: true,
        data: {
          message: `Successfully executed ${module} ${subcommand}.`,
          transactionHash: result.transactionHash,
        },
      };
    }

    default:
      return { success: false, error: `Unknown transaction tool: ${toolName}` };
  }
}

/**
 * Execute create_lease with optional payload attachment upload
 */
async function executeCreateLease(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  address?: string,
  signArbitrary?: (address: string, data: string) => Promise<SignResult>,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  if (!address) {
    return { success: false, error: 'Wallet not connected' };
  }

  let rawItems: Array<{ sku_uuid?: string; sku_name?: string; quantity: number }>;

  try {
    rawItems =
      typeof args.items === 'string'
        ? JSON.parse(args.items)
        : (args.items as Array<{ sku_uuid?: string; sku_name?: string; quantity: number }>);
  } catch {
    return { success: false, error: 'Invalid items format' };
  }

  // Resolve sku_name → sku_uuid where needed
  const needsNameResolution = rawItems.some((item) => item.sku_name && !item.sku_uuid);
  let allSKUs: Awaited<ReturnType<typeof getSKUs>> | undefined;

  if (needsNameResolution) {
    try {
      allSKUs = await getSKUs();
    } catch {
      return { success: false, error: 'Failed to fetch SKU list for name resolution.' };
    }
  }

  const items: Array<{ sku_uuid: string; quantity: number }> = [];
  for (const item of rawItems) {
    let uuid = item.sku_uuid;

    if (!uuid && item.sku_name) {
      if (!allSKUs) {
        return { success: false, error: 'Failed to fetch SKU list for name resolution.' };
      }
      const matches = allSKUs.filter(
        (s) => s.name.toLowerCase() === item.sku_name!.toLowerCase()
      );
      if (matches.length === 0) {
        return {
          success: false,
          error: `No SKU found with name "${item.sku_name}". Use get_skus to list available SKUs.`,
        };
      }
      if (matches.length > 1) {
        const details = matches
          .map((s) => `${s.uuid} (provider ${s.providerUuid})`)
          .join(', ');
        return {
          success: false,
          error: `Multiple SKUs found with name "${item.sku_name}": ${details}. Please specify the sku_uuid directly.`,
        };
      }
      uuid = matches[0].uuid;
    }

    if (!uuid || !isValidUUID(uuid)) {
      return {
        success: false,
        error: `Invalid SKU UUID format: "${uuid}". SKU UUIDs must be valid UUIDs (e.g., "019beb87-09de-7000-beef-ae733e73ff23").`,
      };
    }

    items.push({ sku_uuid: uuid, quantity: item.quantity });
  }

  let metaHashHex: string | undefined;
  let payloadBytes: Uint8Array | undefined;

  // If a payload attachment is provided, use its pre-computed hash
  if (payload) {
    // Fail early if signArbitrary is not available - we need it for payload upload
    if (!signArbitrary) {
      return {
        success: false,
        error:
          'Cannot create lease with payload: wallet does not support message signing (ADR-036). Please use a wallet that supports signArbitrary, or create the lease without a payload attachment.',
      };
    }
    payloadBytes = payload.bytes;
    metaHashHex = payload.hash;
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
      error: result.rawLog ?? 'Transaction failed',
    };
  }

  const leaseUuid = extractLeaseUuidFromTxResult(result);
  const itemsSummary = items.map((item, i) => {
    const name = rawItems[i]?.sku_name;
    return `${item.quantity}x ${name || item.sku_uuid}`;
  }).join(', ');

  // If we have a payload attachment and lease creation succeeded, upload the payload
  if (payload && metaHashHex && payloadBytes && signArbitrary) {
    return handlePayloadUploadAfterLeaseCreation(
      result.transactionHash,
      leaseUuid,
      itemsSummary,
      address,
      metaHashHex,
      payloadBytes,
      signArbitrary
    );
  }

  return {
    success: true,
    data: {
      message: `Successfully created lease${leaseUuid ? ` ${leaseUuid}` : ''} with ${itemsSummary}.`,
      leaseUuid,
      items: itemsSummary,
      transactionHash: result.transactionHash,
    },
  };
}

/**
 * Handle payload upload after successful lease creation
 */
async function handlePayloadUploadAfterLeaseCreation(
  transactionHash: string,
  leaseUuid: string | null,
  itemsSummary: string,
  address: string,
  metaHashHex: string,
  payloadBytes: Uint8Array,
  signArbitrary: (address: string, data: string) => Promise<SignResult>
): Promise<ToolResult> {
  if (!leaseUuid) {
    return {
      success: true,
      data: {
        message: `Lease created with ${itemsSummary}, but could not extract lease UUID for payload upload. You may need to upload the payload manually using upload_payload.`,
        transactionHash,
      },
    };
  }

  try {
    // Get the provider API URL from the lease
    const leaseData = await getLease(leaseUuid);
    if (!leaseData) {
      return {
        success: true,
        data: {
          message: `Lease ${leaseUuid} created with ${itemsSummary}, but could not fetch lease data for payload upload.`,
          leaseUuid,
          transactionHash,
        },
      };
    }

    const provider = await getProviders(false).then((providers) =>
      providers.find((p) => p.uuid === leaseData.providerUuid)
    );

    if (!provider || !provider.apiUrl) {
      return {
        success: true,
        data: {
          message: `Lease ${leaseUuid} created with ${itemsSummary}, but provider API URL not found. You may need to upload the payload manually using upload_payload.`,
          leaseUuid,
          transactionHash,
        },
      };
    }

    // Upload the payload
    const uploadResult = await uploadPayloadToProvider(
      provider.apiUrl,
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
          message: `Lease ${leaseUuid} created with ${itemsSummary}, but payload upload failed: ${uploadResult.error}. You may need to upload the payload manually using upload_payload.`,
          leaseUuid,
          transactionHash,
        },
      };
    }

    return {
      success: true,
      data: {
        message: `Successfully created lease ${leaseUuid} with ${itemsSummary} and uploaded deployment payload.`,
        leaseUuid,
        transactionHash,
      },
    };
  } catch (uploadErr) {
    return {
      success: true,
      data: {
        message: `Lease ${leaseUuid} created with ${itemsSummary}, but payload upload failed: ${uploadErr instanceof Error ? uploadErr.message : 'Unknown error'}. You may need to upload the payload manually using upload_payload.`,
        leaseUuid,
        transactionHash,
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

  if (!lease.metaHash || lease.metaHash.length === 0) {
    return {
      success: false,
      error: 'Lease does not have a meta_hash. Payload upload requires a lease created with meta_hash.',
    };
  }

  // SECURITY: Derive provider API URL from on-chain lease data, not from tool args
  // This prevents prompt injection attacks that could redirect auth tokens to attacker endpoints
  const providers = await getProviders(false);
  const provider = providers.find((p) => p.uuid === lease.providerUuid);

  if (!provider) {
    return {
      success: false,
      error: `Provider not found for lease. Provider UUID: ${lease.providerUuid}`,
    };
  }

  if (!provider.apiUrl) {
    return {
      success: false,
      error: `Provider ${provider.uuid} does not have an API URL configured.`,
    };
  }

  const providerApiUrl = provider.apiUrl;

  // Compute payload hash and verify it matches the lease meta_hash
  const payloadBytes = new TextEncoder().encode(payload);
  const computedHash = await computePayloadHash(payloadBytes);

  // The lease.metaHash is a Uint8Array - convert to hex for comparison
  const leaseMetaHashHex = Array.from(lease.metaHash).map(b => b.toString(16).padStart(2, '0')).join('');

  if (computedHash.toLowerCase() !== leaseMetaHashHex.toLowerCase()) {
    return {
      success: false,
      error: `Payload hash mismatch. Expected: ${leaseMetaHashHex}, Computed: ${computedHash}. The payload must match the hash stored when the lease was created.`,
    };
  }

  return uploadPayloadToProvider(providerApiUrl, leaseUuid, computedHash, payloadBytes, address, signArbitrary);
}
