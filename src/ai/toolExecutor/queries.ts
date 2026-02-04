/**
 * Read-only tool handlers (queries)
 * These tools execute immediately without user confirmation
 */

import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import { cosmosQuery } from '@manifest-network/manifest-mcp-browser';
import {
  getCreditAccount,
  getCreditEstimate,
  getLeasesByTenant,
  getWithdrawableAmount,
  LEASE_STATE_MAP,
  LEASE_STATE_FILTERS,
} from '../../api/billing';
import { getProviders, getSKUs, getSKUsByProvider } from '../../api/sku';
import { getAllBalances } from '../../api/bank';
import { isValidUUID, parseJsonStringArray, toBool } from '../../utils/format';
import { logError } from '../../utils/errors';
import type { ToolResult } from './types';

/**
 * Execute a read-only tool (query).
 * Returns null if the tool is not a query tool.
 */
export async function executeQuery(
  toolName: string,
  args: Record<string, unknown>,
  clientManager: CosmosClientManager | null,
  address: string | undefined
): Promise<ToolResult | null> {
  switch (toolName) {
    case 'get_balance': {
      if (!address) {
        return { success: false, error: 'Wallet not connected' };
      }

      const [balances, creditAccount] = await Promise.all([
        getAllBalances(address),
        getCreditAccount(address).catch((error) => {
          logError('toolExecutor.getBalance.creditAccount', error);
          return null;
        }),
      ]);

      return {
        success: true,
        data: {
          walletBalances: balances,
          creditAccount: creditAccount
            ? {
                creditAddress: creditAccount.creditAccount.creditAddress,
                balance: creditAccount.balances,
                activeLeaseCount: String(creditAccount.creditAccount.activeLeaseCount),
                pendingLeaseCount: String(creditAccount.creditAccount.pendingLeaseCount),
              }
            : null,
        },
      };
    }

    case 'get_leases': {
      if (!address) {
        return { success: false, error: 'Wallet not connected' };
      }

      const stateFilterRaw = args.state as string | undefined;
      let state: Parameters<typeof getLeasesByTenant>[1] = undefined;

      if (stateFilterRaw) {
        // Normalize to lowercase for case-insensitive matching
        const stateFilter = stateFilterRaw.toLowerCase();

        // Validate against known state filters
        if (!LEASE_STATE_FILTERS.includes(stateFilter as (typeof LEASE_STATE_FILTERS)[number])) {
          return {
            success: false,
            error: `Invalid state filter: "${stateFilterRaw}". Valid values are: ${LEASE_STATE_FILTERS.join(', ')}`,
          };
        }

        if (stateFilter !== 'all') {
          state = LEASE_STATE_MAP[stateFilter];
        }
      }

      const leases = await getLeasesByTenant(address, state);
      return {
        success: true,
        data: { leases, count: leases.length },
      };
    }

    case 'get_providers': {
      const activeOnly = toBool(args.active_only);
      const providers = await getProviders(activeOnly);
      return {
        success: true,
        data: { providers, count: providers.length },
      };
    }

    case 'get_skus': {
      const providerUuid = args.provider_uuid as string | undefined;
      const activeOnly = toBool(args.active_only);

      if (providerUuid) {
        if (!isValidUUID(providerUuid)) {
          return {
            success: false,
            error: `Invalid provider_uuid format: "${providerUuid}". Must be a valid UUID.`,
          };
        }
        const skus = await getSKUsByProvider(providerUuid, activeOnly);
        return {
          success: true,
          data: { skus, count: skus.length },
        };
      }

      const skus = await getSKUs(activeOnly);
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

      const remainingHours = Math.floor(Number(estimate.estimatedDurationSeconds) / 3600);
      const remainingDays = Math.floor(remainingHours / 24);

      return {
        success: true,
        data: {
          currentBalance: estimate.currentBalance,
          burnRatePerSecond: estimate.totalRatePerSecond,
          estimatedDurationSeconds: String(estimate.estimatedDurationSeconds),
          remainingHours,
          remainingDays,
          activeLeaseCount: String(estimate.activeLeaseCount),
        },
      };
    }

    case 'get_withdrawable': {
      const leaseUuid = args.lease_uuid;
      if (typeof leaseUuid !== 'string' || !leaseUuid) {
        return { success: false, error: 'lease_uuid is required' };
      }
      if (!isValidUUID(leaseUuid)) {
        return {
          success: false,
          error: `Invalid lease_uuid format: "${leaseUuid}". Must be a valid UUID.`,
        };
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

    default:
      return null; // Not a query tool
  }
}

