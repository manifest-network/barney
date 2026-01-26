/**
 * Tool Executor
 * Bridges AI tool calls to actual blockchain operations
 */

import type { CosmosClientManager } from 'manifest-mcp-browser';
import { cosmosQuery, cosmosTx } from 'manifest-mcp-browser';
import { getCreditAccount, getCreditEstimate, getLeasesByTenant, getWithdrawableAmount } from '../api/billing';
import { getProviders, getSKUsByProvider } from '../api/sku';
import { getAllBalances } from '../api/bank';
import { requiresConfirmation } from './tools';

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
  onConfirmationRequired?: (action: PendingAction) => void;
}

export interface PendingAction {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
}

/**
 * Execute a tool call
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { clientManager, address } = options;

  // Check if confirmation is required
  if (requiresConfirmation(toolName)) {
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
        let queryArgs: string[] = [];

        if (args.args) {
          try {
            queryArgs = typeof args.args === 'string' ? JSON.parse(args.args) : args.args as string[];
          } catch {
            queryArgs = [];
          }
        }

        const result = await cosmosQuery(clientManager, module, subcommand, queryArgs);
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

/**
 * Execute a confirmed transaction
 */
export async function executeConfirmedTool(
  toolName: string,
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  address?: string
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
        let items: Array<{ sku_uuid: string; quantity: number }>;

        try {
          items = typeof args.items === 'string' ? JSON.parse(args.items) : args.items as Array<{ sku_uuid: string; quantity: number }>;
        } catch {
          return { success: false, error: 'Invalid items format' };
        }

        // Validate UUID format - must be proper UUID like "019beb87-09de-7000-beef-ae733e73ff23"
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        for (const item of items) {
          if (!uuidRegex.test(item.sku_uuid)) {
            return {
              success: false,
              error: `Invalid SKU UUID format: "${item.sku_uuid}". SKU UUIDs must be valid UUIDs (e.g., "019beb87-09de-7000-beef-ae733e73ff23"). You must call get_providers and then get_skus to obtain the correct UUID for the SKU the user wants.`,
            };
          }
        }

        // Format items for the MCP: sku-uuid:quantity format
        const itemArgs = items.map(item => `${item.sku_uuid}:${item.quantity}`);
        const result = await cosmosTx(clientManager, 'billing', 'create-lease', itemArgs, true);
        return {
          success: result.code === 0,
          data: result,
          error: result.code !== 0 ? result.rawLog : undefined,
        };
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
        let txArgs: string[] = [];

        if (args.args) {
          try {
            txArgs = typeof args.args === 'string' ? JSON.parse(args.args) : args.args as string[];
          } catch {
            txArgs = [];
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
      return `Create a new lease with ${itemCount} item(s)?`;
    }
    case 'close_lease':
      return `Close lease ${args.lease_uuid}${args.reason ? ` (reason: ${args.reason})` : ''}?`;
    case 'cosmos_tx':
      return `Execute transaction: ${args.module} ${args.subcommand}?`;
    default:
      return `Execute ${toolName}?`;
  }
}
