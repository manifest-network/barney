import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeTool, executeConfirmedTool } from './index';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-core';
import type { ToolResult, ToolExecutorOptions } from './types';

vi.mock('./compositeQueries', () => ({
  executeListApps: vi.fn(),
  executeAppStatus: vi.fn(),
  executeGetBalance: vi.fn(),
  executeGetLogs: vi.fn(),
  executeBrowseCatalog: vi.fn(),
  executeCosmosQuery: vi.fn(),
  executeLeaseHistory: vi.fn(),
  executeAppDiagnostics: vi.fn(),
  executeAppReleases: vi.fn(),
  executeRequestFaucet: vi.fn(),
}));

vi.mock('./compositeTransactions', () => ({
  executeDeployApp: vi.fn(),
  executeConfirmedDeployApp: vi.fn(),
  executeStopApp: vi.fn(),
  executeConfirmedStopApp: vi.fn(),
  executeFundCredits: vi.fn(),
  executeConfirmedFundCredits: vi.fn(),
  executeCosmosTransaction: vi.fn(),
  executeConfirmedCosmosTx: vi.fn(),
  executeConfirmedBatchDeploy: vi.fn(),
  executeRestartApp: vi.fn(),
  executeConfirmedRestartApp: vi.fn(),
  executeUpdateApp: vi.fn(),
  executeConfirmedUpdateApp: vi.fn(),
}));

import {
  executeGetBalance,
  executeGetLogs,
  executeListApps,
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
  executeFundCredits,
  executeConfirmedFundCredits,
  executeStopApp,
  executeConfirmedStopApp,
  executeCosmosTransaction,
  executeConfirmedCosmosTx,
  executeConfirmedBatchDeploy,
  executeRestartApp,
  executeConfirmedRestartApp,
  executeUpdateApp,
  executeConfirmedUpdateApp,
} from './compositeTransactions';

const CLIENT_MANAGER = {} as CosmosClientManager;
const ADDRESS = 'manifest1abc';

function makeOptions(overrides: Partial<ToolExecutorOptions> = {}): ToolExecutorOptions {
  return {
    clientManager: CLIENT_MANAGER,
    address: ADDRESS,
    ...overrides,
  };
}

describe('executeTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Query tools ---

  it('routes get_balance to executor', async () => {
    const queryResult: ToolResult = { success: true, data: { credits: 100 } };
    vi.mocked(executeGetBalance).mockResolvedValue(queryResult);

    const result = await executeTool('get_balance', {}, makeOptions());
    expect(result).toBe(queryResult);
    expect(executeGetBalance).toHaveBeenCalled();
  });

  it('routes list_apps to executor', async () => {
    const queryResult: ToolResult = { success: true, data: { apps: [], count: 0 } };
    vi.mocked(executeListApps).mockResolvedValue(queryResult);

    const result = await executeTool('list_apps', {}, makeOptions());
    expect(result).toBe(queryResult);
  });

  it('routes browse_catalog to executor', async () => {
    const queryResult: ToolResult = { success: true, data: { providers: [], tiers: {} } };
    vi.mocked(executeBrowseCatalog).mockResolvedValue(queryResult);

    const result = await executeTool('browse_catalog', {}, makeOptions());
    expect(result).toBe(queryResult);
  });

  it('routes get_logs to executor', async () => {
    const queryResult: ToolResult = { success: true, data: { app_name: 'my-app', logs: {}, truncated: false } };
    vi.mocked(executeGetLogs).mockResolvedValue(queryResult);

    const result = await executeTool('get_logs', { app_name: 'my-app' }, makeOptions());
    expect(result).toBe(queryResult);
    expect(executeGetLogs).toHaveBeenCalledWith({ app_name: 'my-app' }, expect.any(Object));
  });

  it('routes lease_history to executor', async () => {
    const queryResult: ToolResult = { success: true, data: { leases: [], count: 0, total: 0 } };
    vi.mocked(executeLeaseHistory).mockResolvedValue(queryResult);

    const result = await executeTool('lease_history', { state: 'active' }, makeOptions());
    expect(result).toBe(queryResult);
    expect(executeLeaseHistory).toHaveBeenCalledWith({ state: 'active' }, expect.any(Object));
  });

  it('routes cosmos_query to executor', async () => {
    const queryResult: ToolResult = { success: true, data: { params: {} } };
    vi.mocked(executeCosmosQuery).mockResolvedValue(queryResult);

    const result = await executeTool('cosmos_query', { module: 'bank', subcommand: 'params' }, makeOptions());
    expect(result).toBe(queryResult);
    expect(executeCosmosQuery).toHaveBeenCalledWith({ module: 'bank', subcommand: 'params' }, CLIENT_MANAGER);
  });

  // --- TX tools ---

  it('routes deploy_app to executor', async () => {
    const confirmResult: ToolResult = {
      success: true,
      requiresConfirmation: true,
      confirmationMessage: 'Deploy test-app?',
      pendingAction: { toolName: 'deploy_app', args: {} },
    };
    vi.mocked(executeDeployApp).mockResolvedValue(confirmResult);

    const result = await executeTool('deploy_app', {}, makeOptions());
    expect(result.requiresConfirmation).toBe(true);
  });

  it('routes stop_app to executor', async () => {
    const confirmResult: ToolResult = {
      success: true,
      requiresConfirmation: true,
      confirmationMessage: 'Stop app?',
      pendingAction: { toolName: 'stop_app', args: {} },
    };
    vi.mocked(executeStopApp).mockResolvedValue(confirmResult);

    const result = await executeTool('stop_app', { name: 'test' }, makeOptions());
    expect(result.requiresConfirmation).toBe(true);
  });

  it('routes fund_credits to executor', async () => {
    const confirmResult: ToolResult = {
      success: true,
      requiresConfirmation: true,
      confirmationMessage: 'Add 50 credits?',
      pendingAction: { toolName: 'fund_credits', args: { amount: 50 } },
    };
    vi.mocked(executeFundCredits).mockReturnValue(confirmResult);

    const result = await executeTool('fund_credits', { amount: 50 }, makeOptions());
    expect(result.requiresConfirmation).toBe(true);
  });

  it('routes cosmos_tx to executor', async () => {
    const confirmResult: ToolResult = {
      success: true,
      requiresConfirmation: true,
      confirmationMessage: 'Execute bank send?',
      pendingAction: { toolName: 'cosmos_tx', args: {} },
    };
    vi.mocked(executeCosmosTransaction).mockReturnValue(confirmResult);

    const result = await executeTool('cosmos_tx', { module: 'bank', subcommand: 'send', args: '[]' }, makeOptions());
    expect(result.requiresConfirmation).toBe(true);
  });

  it('routes restart_app to executor', async () => {
    const confirmResult: ToolResult = {
      success: true,
      requiresConfirmation: true,
      confirmationMessage: 'Restart app?',
      pendingAction: { toolName: 'restart_app', args: {} },
    };
    vi.mocked(executeRestartApp).mockResolvedValue(confirmResult);

    const result = await executeTool('restart_app', { app_name: 'my-app' }, makeOptions());
    expect(result.requiresConfirmation).toBe(true);
  });

  it('routes update_app to executor', async () => {
    const confirmResult: ToolResult = {
      success: true,
      requiresConfirmation: true,
      confirmationMessage: 'Update app?',
      pendingAction: { toolName: 'update_app', args: {} },
    };
    vi.mocked(executeUpdateApp).mockResolvedValue(confirmResult);

    const result = await executeTool('update_app', { app_name: 'my-app' }, makeOptions());
    expect(result.requiresConfirmation).toBe(true);
  });

  it('routes app_diagnostics to executor', async () => {
    const queryResult: ToolResult = { success: true, data: { status: 'running', fail_count: 0, last_error: '' } };
    vi.mocked(executeAppDiagnostics).mockResolvedValue(queryResult);

    const result = await executeTool('app_diagnostics', { app_name: 'my-app' }, makeOptions());
    expect(result).toBe(queryResult);
  });

  it('routes app_releases to executor', async () => {
    const queryResult: ToolResult = { success: true, data: { releases: [], count: 0 } };
    vi.mocked(executeAppReleases).mockResolvedValue(queryResult);

    const result = await executeTool('app_releases', { app_name: 'my-app' }, makeOptions());
    expect(result).toBe(queryResult);
  });

  it('routes request_faucet to executor', async () => {
    const queryResult: ToolResult = { success: true, data: { message: 'Tokens sent!', results: [] } };
    vi.mocked(executeRequestFaucet).mockResolvedValue(queryResult);

    const result = await executeTool('request_faucet', {}, makeOptions());
    expect(result).toBe(queryResult);
    expect(executeRequestFaucet).toHaveBeenCalledWith(expect.any(Object));
  });

  // --- Error handling ---

  it('returns unknown tool error for unrecognized tools', async () => {
    const result = await executeTool('nonexistent', {}, makeOptions());
    expect(result).toEqual({
      success: false,
      error: 'Unknown tool: nonexistent',
    });
  });

  it('catches errors from query tools', async () => {
    vi.mocked(executeGetBalance).mockRejectedValue(new Error('network failure'));

    const result = await executeTool('get_balance', {}, makeOptions());
    expect(result).toEqual({
      success: false,
      error: 'network failure',
    });
  });
});

describe('executeConfirmedTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes deploy_app to confirmed executor', async () => {
    const txResult: ToolResult = { success: true, data: { message: 'deployed' } };
    vi.mocked(executeConfirmedDeployApp).mockResolvedValue(txResult);

    const options = makeOptions();
    const result = await executeConfirmedTool('deploy_app', {}, CLIENT_MANAGER, options);

    expect(result).toBe(txResult);
    expect(executeConfirmedDeployApp).toHaveBeenCalled();
  });

  it('routes batch_deploy to confirmed batch executor', async () => {
    const txResult: ToolResult = { success: true, data: { deployed: ['app1', 'app2'], failed: [], message: 'ok' } };
    vi.mocked(executeConfirmedBatchDeploy).mockResolvedValue(txResult);

    const options = makeOptions();
    const result = await executeConfirmedTool('batch_deploy', { entries: [] }, CLIENT_MANAGER, options);

    expect(result).toBe(txResult);
    expect(executeConfirmedBatchDeploy).toHaveBeenCalled();
  });

  it('routes stop_app to confirmed executor', async () => {
    const txResult: ToolResult = { success: true, data: { message: 'stopped' } };
    vi.mocked(executeConfirmedStopApp).mockResolvedValue(txResult);

    const options = makeOptions();
    const result = await executeConfirmedTool('stop_app', { name: 'test' }, CLIENT_MANAGER, options);

    expect(result).toBe(txResult);
  });

  it('routes fund_credits to confirmed executor', async () => {
    const txResult: ToolResult = { success: true, data: { message: 'funded' } };
    vi.mocked(executeConfirmedFundCredits).mockResolvedValue(txResult);

    const options = makeOptions();
    const result = await executeConfirmedTool('fund_credits', { amount: 50 }, CLIENT_MANAGER, options);

    expect(result).toBe(txResult);
  });

  it('routes cosmos_tx to confirmed executor', async () => {
    const txResult: ToolResult = { success: true, data: { message: 'tx done' } };
    vi.mocked(executeConfirmedCosmosTx).mockResolvedValue(txResult);

    const options = makeOptions();
    const result = await executeConfirmedTool('cosmos_tx', { module: 'bank', subcommand: 'send', args: '[]' }, CLIENT_MANAGER, options);

    expect(result).toBe(txResult);
  });

  it('routes restart_app to confirmed executor', async () => {
    const txResult: ToolResult = { success: true, data: { message: 'restarted' } };
    vi.mocked(executeConfirmedRestartApp).mockResolvedValue(txResult);

    const options = makeOptions();
    const result = await executeConfirmedTool('restart_app', { app_name: 'my-app' }, CLIENT_MANAGER, options);

    expect(result).toBe(txResult);
    expect(executeConfirmedRestartApp).toHaveBeenCalled();
  });

  it('routes update_app to confirmed executor', async () => {
    const txResult: ToolResult = { success: true, data: { message: 'updated' } };
    vi.mocked(executeConfirmedUpdateApp).mockResolvedValue(txResult);

    const options = makeOptions();
    const result = await executeConfirmedTool('update_app', { app_name: 'my-app' }, CLIENT_MANAGER, options);

    expect(result).toBe(txResult);
    expect(executeConfirmedUpdateApp).toHaveBeenCalled();
  });

  it('returns error for unknown confirmed tool', async () => {
    const result = await executeConfirmedTool('nonexistent', {}, CLIENT_MANAGER, makeOptions());
    expect(result).toEqual({
      success: false,
      error: 'Unknown confirmed tool: nonexistent',
    });
  });

  it('catches and wraps errors', async () => {
    vi.mocked(executeConfirmedFundCredits).mockRejectedValue(new Error('tx failed'));

    const result = await executeConfirmedTool('fund_credits', {}, CLIENT_MANAGER, makeOptions());
    expect(result).toEqual({
      success: false,
      error: 'tx failed',
    });
  });
});
