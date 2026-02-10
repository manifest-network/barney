/**
 * Tool Executor
 * Bridges AI tool calls to actual blockchain operations.
 */

import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import {
  executeListApps,
  executeAppStatus,
  executeGetBalance,
  executeGetLogs,
  executeBrowseCatalog,
  executeCosmosQuery,
  executeLeaseHistory,
} from './compositeQueries';
import {
  executeDeployApp,
  executeConfirmedDeployApp,
  executeStopApp,
  executeConfirmedStopApp,
  executeFundCredits,
  executeConfirmedFundCredits,
  executeCosmosTransaction,
  executeConfirmedCosmosTx,
  executeConfirmedBatchDeploy,
} from './compositeTransactions';
import type { ToolResult, ToolExecutorOptions, PayloadAttachment } from './types';

// Re-export types
export type { ToolResult, ToolExecutorOptions, PendingAction, SignResult, PayloadAttachment } from './types';
export type { AppRegistryAccess } from './types';

/** Query tools that execute immediately */
const QUERY_TOOLS = new Set([
  'list_apps',
  'app_status',
  'get_logs',
  'get_balance',
  'browse_catalog',
  'lease_history',
]);

/** TX tools that require user confirmation */
const TX_TOOLS = new Set([
  'deploy_app',
  'stop_app',
  'fund_credits',
]);

/**
 * Execute a tool call from the AI assistant.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  options: ToolExecutorOptions,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  const { clientManager } = options;

  // --- Query tools (execute immediately) ---
  if (QUERY_TOOLS.has(toolName)) {
    try {
      switch (toolName) {
        case 'list_apps':
          return await executeListApps(args, options);
        case 'app_status':
          return await executeAppStatus(args, options);
        case 'get_logs':
          return await executeGetLogs(args, options);
        case 'get_balance':
          return await executeGetBalance(options);
        case 'browse_catalog':
          return await executeBrowseCatalog();
        case 'lease_history':
          return await executeLeaseHistory(args, options);
        default:
          return { success: false, error: `Unknown query tool: ${toolName}` };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // --- TX tools (return confirmation) ---
  if (TX_TOOLS.has(toolName)) {
    try {
      switch (toolName) {
        case 'deploy_app':
          return await executeDeployApp(args, options, payload);
        case 'stop_app':
          return await executeStopApp(args, options);
        case 'fund_credits':
          return executeFundCredits(args, options);
        default:
          return { success: false, error: `Unknown TX tool: ${toolName}` };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // --- cosmos_query ---
  if (toolName === 'cosmos_query') {
    try {
      return await executeCosmosQuery(args, clientManager);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // --- cosmos_tx (requires confirmation) ---
  if (toolName === 'cosmos_tx') {
    return executeCosmosTransaction(args, options);
  }

  return { success: false, error: `Unknown tool: ${toolName}` };
}

/**
 * Execute a transaction that has been confirmed by the user.
 */
export async function executeConfirmedTool(
  toolName: string,
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'deploy_app':
        return await executeConfirmedDeployApp(args, clientManager, options, payload);
      case 'batch_deploy':
        return await executeConfirmedBatchDeploy(args, clientManager, options);
      case 'stop_app':
        return await executeConfirmedStopApp(args, clientManager, options);
      case 'fund_credits':
        return await executeConfirmedFundCredits(args, clientManager);
      case 'cosmos_tx':
        return await executeConfirmedCosmosTx(args, clientManager);
      default:
        return { success: false, error: `Unknown confirmed tool: ${toolName}` };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
