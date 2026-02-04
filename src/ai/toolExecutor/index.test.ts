import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeTool, executeConfirmedTool } from './index';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import type { ToolResult, SignResult } from './types';

vi.mock('../tools', () => ({
  requiresConfirmation: vi.fn(),
}));

vi.mock('./validation', () => ({
  validateConfirmationToolArgs: vi.fn(),
  getConfirmationMessage: vi.fn(),
}));

vi.mock('./queries', () => ({
  executeQuery: vi.fn(),
}));

vi.mock('./transactions', () => ({
  executeTransaction: vi.fn(),
}));

import { requiresConfirmation } from '../tools';
import { validateConfirmationToolArgs, getConfirmationMessage } from './validation';
import { executeQuery } from './queries';
import { executeTransaction } from './transactions';

const mockRequiresConfirmation = vi.mocked(requiresConfirmation);
const mockValidateArgs = vi.mocked(validateConfirmationToolArgs);
const mockGetConfirmationMessage = vi.mocked(getConfirmationMessage);
const mockExecuteQuery = vi.mocked(executeQuery);
const mockExecuteTransaction = vi.mocked(executeTransaction);

const CLIENT_MANAGER = {} as CosmosClientManager;
const ADDRESS = 'manifest1abc';

describe('executeTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Confirmation-required tools ---

  it('returns confirmation for confirmation-required tools with valid args', async () => {
    mockRequiresConfirmation.mockReturnValue(true);
    mockValidateArgs.mockReturnValue(null);
    mockGetConfirmationMessage.mockReturnValue('Fund 1000umfx?');

    const args = { amount: '1000umfx' };
    const result = await executeTool('fund_credit', args, {
      clientManager: CLIENT_MANAGER,
      address: ADDRESS,
    });

    expect(result).toEqual({
      success: true,
      requiresConfirmation: true,
      confirmationMessage: 'Fund 1000umfx?',
      pendingAction: { toolName: 'fund_credit', args },
    });
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  it('returns validation error for confirmation-required tools with invalid args', async () => {
    mockRequiresConfirmation.mockReturnValue(true);
    mockValidateArgs.mockReturnValue('Missing required argument: amount.');

    const result = await executeTool('fund_credit', {}, {
      clientManager: CLIENT_MANAGER,
      address: ADDRESS,
    });

    expect(result).toEqual({
      success: false,
      error: 'Missing required argument: amount.',
    });
    expect(mockGetConfirmationMessage).not.toHaveBeenCalled();
  });

  // --- Query tools ---

  it('delegates to executeQuery for non-confirmation tools', async () => {
    mockRequiresConfirmation.mockReturnValue(false);
    const queryResult: ToolResult = { success: true, data: { balances: [] } };
    mockExecuteQuery.mockResolvedValue(queryResult);

    const result = await executeTool('get_balance', {}, {
      clientManager: CLIENT_MANAGER,
      address: ADDRESS,
    });

    expect(result).toBe(queryResult);
    expect(mockExecuteQuery).toHaveBeenCalledWith('get_balance', {}, CLIENT_MANAGER, ADDRESS);
  });

  it('returns unknown tool error when executeQuery returns null', async () => {
    mockRequiresConfirmation.mockReturnValue(false);
    mockExecuteQuery.mockResolvedValue(null);

    const result = await executeTool('nonexistent', {}, {
      clientManager: CLIENT_MANAGER,
      address: ADDRESS,
    });

    expect(result).toEqual({
      success: false,
      error: 'Unknown tool: nonexistent',
    });
  });

  it('catches and wraps errors thrown by executeQuery', async () => {
    mockRequiresConfirmation.mockReturnValue(false);
    mockExecuteQuery.mockRejectedValue(new Error('network failure'));

    const result = await executeTool('get_balance', {}, {
      clientManager: CLIENT_MANAGER,
      address: ADDRESS,
    });

    expect(result).toEqual({
      success: false,
      error: 'network failure',
    });
  });

  it('handles non-Error throws from executeQuery', async () => {
    mockRequiresConfirmation.mockReturnValue(false);
    mockExecuteQuery.mockRejectedValue('string error');

    const result = await executeTool('get_balance', {}, {
      clientManager: CLIENT_MANAGER,
      address: ADDRESS,
    });

    expect(result).toEqual({
      success: false,
      error: 'Unknown error',
    });
  });
});

describe('executeConfirmedTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to executeTransaction and returns result', async () => {
    const txResult: ToolResult = { success: true, data: { message: 'done' } };
    mockExecuteTransaction.mockResolvedValue(txResult);

    const result = await executeConfirmedTool('fund_credit', { amount: '1000umfx' }, CLIENT_MANAGER, ADDRESS);

    expect(result).toBe(txResult);
    expect(mockExecuteTransaction).toHaveBeenCalledWith(
      'fund_credit', { amount: '1000umfx' }, CLIENT_MANAGER, ADDRESS, undefined, undefined,
    );
  });

  it('passes signArbitrary and payload through', async () => {
    const txResult: ToolResult = { success: true, data: { message: 'uploaded' } };
    mockExecuteTransaction.mockResolvedValue(txResult);

    const signArbitrary = vi.fn<(address: string, data: string) => Promise<SignResult>>();
    const payload = { bytes: new Uint8Array([1]), size: 1, hash: 'a'.repeat(64) };

    await executeConfirmedTool('upload_payload', {}, CLIENT_MANAGER, ADDRESS, signArbitrary, payload);

    expect(mockExecuteTransaction).toHaveBeenCalledWith(
      'upload_payload', {}, CLIENT_MANAGER, ADDRESS, signArbitrary, payload,
    );
  });

  it('catches and wraps errors thrown by executeTransaction', async () => {
    mockExecuteTransaction.mockRejectedValue(new Error('tx broadcast failed'));

    const result = await executeConfirmedTool('fund_credit', {}, CLIENT_MANAGER);

    expect(result).toEqual({
      success: false,
      error: 'tx broadcast failed',
    });
  });

  it('handles non-Error throws from executeTransaction', async () => {
    mockExecuteTransaction.mockRejectedValue(42);

    const result = await executeConfirmedTool('fund_credit', {}, CLIENT_MANAGER);

    expect(result).toEqual({
      success: false,
      error: 'Unknown error',
    });
  });
});
