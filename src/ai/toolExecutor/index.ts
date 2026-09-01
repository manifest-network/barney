/**
 * Tool Executor
 * Bridges AI tool calls to actual blockchain operations.
 */

import {
  executeListApps,
  executeAppStatus,
  executeGetBalance,
  executeGetLogs,
  executeBrowseCatalog,
  executeCosmosQuery,
  executeLeaseHistory,
  executeAppDiagnostics,
  executeAppReleases,
  executeRequestFaucet,
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
  executeRestartApp,
  executeConfirmedRestartApp,
  executeUpdateApp,
  executeConfirmedUpdateApp,
  executeSetCustomDomain,
  executeConfirmedSetCustomDomain,
} from './compositeTransactions';
import type { ToolResult, ToolExecutorOptions, PayloadAttachment } from './types';

// Re-export types
export type { ToolResult, ToolExecutorOptions, PendingAction, SignResult, PayloadAttachment, AuthTokens, SigningContext, TransactionAuthorization } from './types';
export type { AppRegistryAccess } from './types';

/** Query tools that execute immediately */
const QUERY_TOOLS = new Set([
  'list_apps',
  'app_status',
  'get_logs',
  'get_balance',
  'browse_catalog',
  'lease_history',
  'app_diagnostics',
  'app_releases',
  'request_faucet',
]);

/** TX tools that require user confirmation */
const TX_TOOLS = new Set([
  'deploy_app',
  'stop_app',
  'fund_credits',
  'restart_app',
  'update_app',
  'set_custom_domain',
]);

/** Public TX tools plus the UI-only batch pseudo-tool and raw escape hatch. */
const CONFIRMED_TX_TOOLS = new Set([...TX_TOOLS, 'batch_deploy', 'cosmos_tx']);

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
          return await executeBrowseCatalog(options);
        case 'lease_history':
          return await executeLeaseHistory(args, options);
        case 'app_diagnostics':
          return await executeAppDiagnostics(args, options);
        case 'app_releases':
          return await executeAppReleases(args, options);
        case 'request_faucet':
          return await executeRequestFaucet(options);
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
        case 'restart_app':
          return await executeRestartApp(args, options);
        case 'update_app':
          return await executeUpdateApp(args, options, payload);
        case 'set_custom_domain':
          return await executeSetCustomDomain(args, options);
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
  options: ToolExecutorOptions,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  if (!CONFIRMED_TX_TOOLS.has(toolName)) {
    return { success: false, error: `Unknown confirmed tool: ${toolName}` };
  }

  try {
    const { authorization, assertAuthorization, clientManager } = options;
    if (!authorization || !assertAuthorization) {
      return { success: false, error: 'Transaction authorization context is missing.' };
    }
    if (!clientManager) {
      return { success: false, error: 'Transaction authorization client is missing.' };
    }
    if (options.address !== authorization.originAddress) {
      return { success: false, error: 'Transaction cancelled: authorized wallet address mismatch.' };
    }
    if ('address' in args && args.address !== authorization.originAddress) {
      return { success: false, error: 'Transaction cancelled: action target address does not match the authorized wallet.' };
    }
    assertAuthorization();
    options.signal?.throwIfAborted();

    switch (toolName) {
      case 'deploy_app':
        return await executeConfirmedDeployApp(args, clientManager, options, payload);
      case 'batch_deploy':
        return await executeConfirmedBatchDeploy(args, clientManager, options);
      case 'stop_app':
        return await executeConfirmedStopApp(args, clientManager, options);
      case 'fund_credits':
        return await executeConfirmedFundCredits(args, clientManager, options);
      case 'cosmos_tx':
        return await executeConfirmedCosmosTx(args, clientManager, options);
      case 'restart_app':
        return await executeConfirmedRestartApp(args, clientManager, options);
      case 'update_app':
        return await executeConfirmedUpdateApp(args, clientManager, options, payload);
      case 'set_custom_domain':
        return await executeConfirmedSetCustomDomain(args, clientManager, options);
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
