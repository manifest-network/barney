/**
 * Tool Executor
 * Bridges AI tool calls to actual blockchain operations
 */

import type { CosmosClientManager } from 'manifest-mcp-browser';
import { cosmosQuery, cosmosTx } from 'manifest-mcp-browser';
import { getCreditAccount, getCreditEstimate, getLeasesByTenant, getWithdrawableAmount, getLease } from '../api/billing';
import { getProviders, getSKUsByProvider } from '../api/sku';
import { getAllBalances } from '../api/bank';
import {
  computePayloadHash,
  isValidMetaHash,
  createLeaseDataSignMessage,
  createLeaseDataAuthToken,
  uploadLeaseData,
} from '../api/provider-api';
import { requiresConfirmation } from './tools';
import { isValidUUID, parseJsonStringArray } from '../utils/format';

export interface SignResult {
  pub_key: { type: string; value: string };
  signature: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
  pendingAction?: {
    toolName: string;
    args: Record<string, unknown>;
  };
}

export interface ToolExecutorOptions {
  clientManager: CosmosClientManager | null;
  address: string | undefined;
  signArbitrary?: (address: string, data: string) => Promise<SignResult>;
  onConfirmationRequired?: (action: PendingAction) => void;
}

export interface PendingAction {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
}

/**
 * Validate required arguments for confirmation-required tools.
 * Returns an error message if validation fails, or null if valid.
 */
function validateConfirmationToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  address: string | undefined
): string | null {
  switch (toolName) {
    case 'fund_credit': {
      if (!address) {
        return 'Wallet not connected. Please connect your wallet first.';
      }
      const amount = args.amount as string | undefined;
      if (!amount || typeof amount !== 'string' || amount.trim() === '') {
        return 'Missing required argument: amount. Please specify an amount (e.g., "1000000umfx").';
      }
      // Basic format check - should be digits followed by denomination
      if (!/^\d+[a-zA-Z]/.test(amount)) {
        return `Invalid amount format: "${amount}". Use format like "1000000umfx" or "10000000factory/...".`;
      }
      return null;
    }

    case 'create_lease': {
      const itemsRaw = args.items;
      if (!itemsRaw) {
        return 'Missing required argument: items. Please specify items as a JSON array.';
      }

      let items: unknown[];
      try {
        items = typeof itemsRaw === 'string' ? JSON.parse(itemsRaw) : itemsRaw as unknown[];
      } catch {
        return `Invalid items format: could not parse JSON. Use format: [{"sku_uuid": "...", "quantity": 1}]`;
      }

      if (!Array.isArray(items) || items.length === 0) {
        return 'Items must be a non-empty array.';
      }

      // Validate each item has required fields
      for (let i = 0; i < items.length; i++) {
        const item = items[i] as Record<string, unknown>;
        if (!item || typeof item !== 'object') {
          return `Invalid item at index ${i}: must be an object.`;
        }
        if (!item.sku_uuid || typeof item.sku_uuid !== 'string') {
          return `Missing sku_uuid in item at index ${i}.`;
        }
        if (!isValidUUID(item.sku_uuid)) {
          return `Invalid SKU UUID format in item at index ${i}: "${item.sku_uuid}". You must call get_providers and get_skus first to obtain valid UUIDs.`;
        }
        if (typeof item.quantity !== 'number' || item.quantity < 1) {
          return `Invalid quantity in item at index ${i}: must be a positive number.`;
        }
      }
      return null;
    }

    case 'close_lease': {
      const leaseUuid = args.lease_uuid as string | undefined;
      if (!leaseUuid || typeof leaseUuid !== 'string' || leaseUuid.trim() === '') {
        return 'Missing required argument: lease_uuid.';
      }
      return null;
    }

    case 'cosmos_tx': {
      const module = args.module as string | undefined;
      const subcommand = args.subcommand as string | undefined;
      if (!module || typeof module !== 'string' || module.trim() === '') {
        return 'Missing required argument: module.';
      }
      if (!subcommand || typeof subcommand !== 'string' || subcommand.trim() === '') {
        return 'Missing required argument: subcommand.';
      }

      // Validate args is present and is a JSON array of strings
      const txArgs = args.args;
      if (!txArgs) {
        return 'Missing required argument: args. Please provide a JSON array of string arguments.';
      }

      let parsedArgs: unknown[];
      try {
        parsedArgs = typeof txArgs === 'string' ? JSON.parse(txArgs) : txArgs as unknown[];
      } catch {
        return `Invalid args format: could not parse JSON. Use format: ["arg1", "arg2"]`;
      }

      if (!Array.isArray(parsedArgs)) {
        return 'Invalid args format: must be a JSON array of strings.';
      }

      // Validate each element is a string
      for (let i = 0; i < parsedArgs.length; i++) {
        if (typeof parsedArgs[i] !== 'string') {
          return `Invalid args format: element at index ${i} must be a string.`;
        }
      }

      return null;
    }

    case 'upload_payload': {
      const leaseUuid = args.lease_uuid as string | undefined;
      if (!leaseUuid || typeof leaseUuid !== 'string' || leaseUuid.trim() === '') {
        return 'Missing required argument: lease_uuid.';
      }

      if (!isValidUUID(leaseUuid)) {
        return `Invalid lease UUID format: "${leaseUuid}". Use format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.`;
      }

      const payload = args.payload as string | undefined;
      if (!payload || typeof payload !== 'string' || payload.trim() === '') {
        return 'Missing required argument: payload. Please provide the deployment data to upload.';
      }

      const providerApiUrl = args.provider_api_url as string | undefined;
      if (!providerApiUrl || typeof providerApiUrl !== 'string' || providerApiUrl.trim() === '') {
        return 'Missing required argument: provider_api_url. Please provide the provider API URL.';
      }

      // Basic URL validation
      try {
        new URL(providerApiUrl);
      } catch {
        return `Invalid provider_api_url format: "${providerApiUrl}". Must be a valid URL.`;
      }

      return null;
    }

    default:
      return null;
  }
}

/**
 * Execute a tool call from the AI assistant.
 *
 * For read-only operations (queries), executes immediately and returns results.
 * For state-changing operations (transactions), returns a pending confirmation
 * that requires user approval before execution.
 *
 * @param toolName - Name of the tool to execute (must be in VALID_TOOL_NAMES)
 * @param args - Tool-specific arguments
 * @param options - Executor options including client manager and wallet address
 * @returns ToolResult with success status, data or error, and confirmation info if needed
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { clientManager, address } = options;

  // Check if confirmation is required
  if (requiresConfirmation(toolName)) {
    // Validate required args BEFORE requesting confirmation
    const validationError = validateConfirmationToolArgs(toolName, args, address);
    if (validationError) {
      return {
        success: false,
        error: validationError,
      };
    }

    return {
      success: true,
      requiresConfirmation: true,
      confirmationMessage: getConfirmationMessage(toolName, args),
      pendingAction: { toolName, args },
    };
  }

  try {
    switch (toolName) {
      case 'get_balance': {
        if (!address) {
          return { success: false, error: 'Wallet not connected' };
        }

        const [balances, creditAccount] = await Promise.all([
          getAllBalances(address),
          getCreditAccount(address).catch(() => null),
        ]);

        return {
          success: true,
          data: {
            walletBalances: balances,
            creditAccount: creditAccount ? {
              creditAddress: creditAccount.credit_account.credit_address,
              balance: creditAccount.balances,
              activeLeaseCount: creditAccount.credit_account.active_lease_count,
              pendingLeaseCount: creditAccount.credit_account.pending_lease_count,
            } : null,
          },
        };
      }

      case 'get_leases': {
        if (!address) {
          return { success: false, error: 'Wallet not connected' };
        }

        const stateFilter = args.state as string | undefined;
        let state: Parameters<typeof getLeasesByTenant>[1] = undefined;

        if (stateFilter && stateFilter !== 'all') {
          const stateMap: Record<string, Parameters<typeof getLeasesByTenant>[1]> = {
            pending: 'LEASE_STATE_PENDING',
            active: 'LEASE_STATE_ACTIVE',
            closed: 'LEASE_STATE_CLOSED',
            rejected: 'LEASE_STATE_REJECTED',
            expired: 'LEASE_STATE_EXPIRED',
          };
          state = stateMap[stateFilter];
        }

        const leases = await getLeasesByTenant(address, state);
        return {
          success: true,
          data: { leases, count: leases.length },
        };
      }

      case 'get_providers': {
        const activeOnly = args.active_only === 'true';
        const providers = await getProviders(activeOnly);
        return {
          success: true,
          data: { providers, count: providers.length },
        };
      }

      case 'get_skus': {
        const providerUuid = args.provider_uuid as string;
        if (!providerUuid) {
          return { success: false, error: 'provider_uuid is required' };
        }

        const skus = await getSKUsByProvider(providerUuid);
        return {
          success: true,
          data: { skus, count: skus.length },
        };
      }

      case 'get_credit_estimate': {
        if (!address) {
          return { success: false, error: 'Wallet not connected' };
        }

        const estimate = await getCreditEstimate(address);
        if (!estimate) {
          return {
            success: true,
            data: { message: 'No active credit account or leases' },
          };
        }

        const remainingHours = Math.floor(parseInt(estimate.estimated_duration_seconds) / 3600);
        const remainingDays = Math.floor(remainingHours / 24);

        return {
          success: true,
          data: {
            currentBalance: estimate.current_balance,
            burnRatePerSecond: estimate.total_rate_per_second,
            estimatedDurationSeconds: estimate.estimated_duration_seconds,
            remainingHours,
            remainingDays,
            activeLeaseCount: estimate.active_lease_count,
          },
        };
      }

      case 'get_withdrawable': {
        const leaseUuid = args.lease_uuid as string;
        if (!leaseUuid) {
          return { success: false, error: 'lease_uuid is required' };
        }

        const amounts = await getWithdrawableAmount(leaseUuid);
        return {
          success: true,
          data: { leaseUuid, withdrawableAmounts: amounts },
        };
      }

      case 'cosmos_query': {
        if (!clientManager) {
          return { success: false, error: 'Not connected to blockchain' };
        }

        const module = args.module as string;
        const subcommand = args.subcommand as string;

        const parseResult = parseJsonStringArray(args.args);
        if (parseResult.error) {
          return { success: false, error: parseResult.error };
        }

        const result = await cosmosQuery(clientManager, module, subcommand, parseResult.data);
        return { success: true, data: result };
      }

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export interface ExecuteConfirmedToolOptions {
  clientManager: CosmosClientManager;
  address?: string;
  signArbitrary?: (address: string, data: string) => Promise<SignResult>;
}

/**
 * Execute a transaction that has been confirmed by the user.
 *
 * This function handles the actual blockchain transaction execution
 * after the user has approved the pending action.
 *
 * @param toolName - Name of the confirmed tool to execute
 * @param args - Tool-specific arguments (validated during confirmation)
 * @param clientManager - CosmosClientManager for signing and broadcasting
 * @param address - User's wallet address (optional for some operations)
 * @param signArbitrary - Function to sign arbitrary data with ADR-036 (for payload uploads)
 * @returns ToolResult with transaction result or error
 */
export async function executeConfirmedTool(
  toolName: string,
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  address?: string,
  signArbitrary?: (address: string, data: string) => Promise<SignResult>
): Promise<ToolResult> {
  try {
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

      case 'create_lease': {
        if (!address) {
          return { success: false, error: 'Wallet not connected' };
        }

        let items: Array<{ sku_uuid: string; quantity: number }>;

        try {
          items = typeof args.items === 'string' ? JSON.parse(args.items) : args.items as Array<{ sku_uuid: string; quantity: number }>;
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
          payloadBytes = new TextEncoder().encode(deploymentData);
          metaHashHex = await computePayloadHash(payloadBytes);
        }

        // Format items for the MCP: sku-uuid:quantity format
        const itemArgs = items.map(item => `${item.sku_uuid}:${item.quantity}`);

        // If meta_hash is set, include it in the create-lease command
        // The MCP supports: create-lease [--meta-hash <hash>] <item1> <item2> ...
        const cmdArgs = metaHashHex
          ? ['--meta-hash', metaHashHex, ...itemArgs]
          : itemArgs;

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
          try {
            // Extract lease UUID from the transaction result
            // The lease UUID is typically in the events
            const leaseUuid = extractLeaseUuidFromTxResult(result as unknown as Record<string, unknown>);

            if (!leaseUuid) {
              return {
                success: true,
                data: {
                  ...result,
                  warning: 'Lease created but could not extract UUID for payload upload. You may need to upload payload manually.',
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
            const provider = await getProviders(false).then(providers =>
              providers.find(p => p.uuid === leaseData.provider_uuid)
            );

            if (!provider || !provider.api_url) {
              return {
                success: true,
                data: {
                  ...result,
                  leaseUuid,
                  warning: 'Lease created but provider API URL not found. You may need to upload payload manually using upload_payload tool.',
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

        return {
          success: true,
          data: result,
        };
      }

      case 'upload_payload': {
        if (!address) {
          return { success: false, error: 'Wallet not connected' };
        }
        if (!signArbitrary) {
          return { success: false, error: 'Signing not available. Please reconnect your wallet.' };
        }

        const leaseUuid = args.lease_uuid as string;
        const payload = args.payload as string;
        const providerApiUrl = args.provider_api_url as string;

        if (!leaseUuid || !payload || !providerApiUrl) {
          return { success: false, error: 'Missing required arguments: lease_uuid, payload, and provider_api_url are required.' };
        }

        // Get the lease to verify meta_hash
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

        const uploadResult = await uploadPayloadToProvider(
          providerApiUrl,
          leaseUuid,
          computedHash,
          payloadBytes,
          address,
          signArbitrary
        );

        return uploadResult;
      }

      case 'close_lease': {
        const leaseUuid = args.lease_uuid as string;
        if (!leaseUuid) {
          return { success: false, error: 'lease_uuid is required' };
        }

        // close-lease expects lease UUIDs as arguments (reason is handled internally by MCP)
        const result = await cosmosTx(clientManager, 'billing', 'close-lease', [leaseUuid], true);
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

        let txArgs: string[];
        try {
          txArgs = typeof args.args === 'string' ? JSON.parse(args.args) : args.args as string[];
        } catch {
          return { success: false, error: 'Invalid args format: could not parse JSON array' };
        }

        if (!Array.isArray(txArgs)) {
          return { success: false, error: 'Invalid args format: must be a JSON array of strings' };
        }

        // Validate each element is a string
        for (let i = 0; i < txArgs.length; i++) {
          if (typeof txArgs[i] !== 'string') {
            return { success: false, error: `Invalid args format: element at index ${i} must be a string` };
          }
        }

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
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get a human-readable confirmation message for a tool
 */
function getConfirmationMessage(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'fund_credit':
      return `Fund your credit account with ${args.amount}?`;
    case 'create_lease': {
      let itemCount = 0;
      try {
        const items = typeof args.items === 'string' ? JSON.parse(args.items) : args.items;
        itemCount = Array.isArray(items) ? items.length : 0;
      } catch {
        itemCount = 0;
      }
      const hasDeploymentData = !!args.deployment_data;
      return hasDeploymentData
        ? `Create a new lease with ${itemCount} item(s) and upload deployment data?`
        : `Create a new lease with ${itemCount} item(s)?`;
    }
    case 'close_lease':
      return `Close lease ${args.lease_uuid}${args.reason ? ` (reason: ${args.reason})` : ''}?`;
    case 'upload_payload':
      return `Upload deployment payload to lease ${args.lease_uuid}?`;
    case 'cosmos_tx':
      return `Execute transaction: ${args.module} ${args.subcommand}?`;
    default:
      return `Execute ${toolName}?`;
  }
}

/**
 * Extract lease UUID from a create-lease transaction result.
 * Looks for the UUID in transaction events.
 */
function extractLeaseUuidFromTxResult(result: Record<string, unknown>): string | null {
  try {
    // Try to find the lease UUID in the transaction events
    const events = result.events as Array<{
      type: string;
      attributes: Array<{ key: string; value: string }>;
    }> | undefined;

    if (events) {
      for (const event of events) {
        if (event.type === 'create_lease' || event.type === 'liftedinit.billing.v1.EventCreateLease') {
          const uuidAttr = event.attributes.find(
            (attr) => attr.key === 'lease_uuid' || attr.key === 'uuid'
          );
          if (uuidAttr) {
            return uuidAttr.value;
          }
        }
      }
    }

    // Also check the response data directly
    const data = result.data as Record<string, unknown> | undefined;
    if (data && typeof data.lease_uuid === 'string') {
      return data.lease_uuid;
    }

    // Check parsed logs
    const logs = result.logs as Array<{
      events: Array<{
        type: string;
        attributes: Array<{ key: string; value: string }>;
      }>;
    }> | undefined;

    if (logs) {
      for (const log of logs) {
        for (const event of log.events || []) {
          if (event.type === 'create_lease' || event.type === 'liftedinit.billing.v1.EventCreateLease') {
            const uuidAttr = event.attributes.find(
              (attr) => attr.key === 'lease_uuid' || attr.key === 'uuid'
            );
            if (uuidAttr) {
              return uuidAttr.value;
            }
          }
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Upload payload to provider with ADR-036 authentication.
 */
async function uploadPayloadToProvider(
  providerApiUrl: string,
  leaseUuid: string,
  metaHashHex: string,
  payload: Uint8Array,
  address: string,
  signArbitrary: (address: string, data: string) => Promise<SignResult>
): Promise<ToolResult> {
  try {
    // Validate meta_hash format
    if (!isValidMetaHash(metaHashHex)) {
      return {
        success: false,
        error: `Invalid meta_hash format: ${metaHashHex}. Must be 64 hex characters.`,
      };
    }

    // Create the sign message
    const timestamp = Math.floor(Date.now() / 1000);
    const signMessage = createLeaseDataSignMessage(leaseUuid, metaHashHex, timestamp);

    // Sign the message using ADR-036
    const signResult = await signArbitrary(address, signMessage);

    // Create the auth token
    const authToken = createLeaseDataAuthToken(
      address,
      leaseUuid,
      metaHashHex,
      timestamp,
      signResult.pub_key.value,
      signResult.signature
    );

    // Upload the payload
    await uploadLeaseData(providerApiUrl, leaseUuid, payload, authToken);

    return {
      success: true,
      data: {
        message: 'Payload uploaded successfully',
        leaseUuid,
        metaHash: metaHashHex,
      },
    };
  } catch (error) {
    // Handle specific error codes
    if (error instanceof Error) {
      const errorMsg = error.message.toLowerCase();

      if (errorMsg.includes('409') || errorMsg.includes('conflict')) {
        return {
          success: true,
          data: {
            message: 'Payload already uploaded (idempotent success)',
            leaseUuid,
            metaHash: metaHashHex,
          },
        };
      }

      if (errorMsg.includes('401') || errorMsg.includes('unauthorized')) {
        return {
          success: false,
          error: 'Authentication failed. The signature may have expired. Please try again.',
        };
      }

      if (errorMsg.includes('404') || errorMsg.includes('not found')) {
        return {
          success: false,
          error: 'Lease not found or not in PENDING state. Payload upload is only allowed for pending leases.',
        };
      }

      if (errorMsg.includes('400') || errorMsg.includes('bad request')) {
        return {
          success: false,
          error: 'Payload hash does not match the lease meta_hash, or payload is invalid.',
        };
      }
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during payload upload',
    };
  }
}
