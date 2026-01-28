/**
 * Tool Executor
 * Bridges AI tool calls to actual blockchain operations
 */

import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import { requiresConfirmation } from '../tools';
import { validateConfirmationToolArgs, getConfirmationMessage } from './validation';
import { executeQuery } from './queries';
import { executeTransaction } from './transactions';
import type { ToolResult, ToolExecutorOptions, SignResult, PayloadAttachment } from './types';

// Re-export types
export type { ToolResult, ToolExecutorOptions, PendingAction, SignResult, PayloadAttachment } from './types';

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

  // Execute read-only tools immediately
  try {
    const queryResult = await executeQuery(toolName, args, clientManager, address);
    if (queryResult !== null) {
      return queryResult;
    }
    return { success: false, error: `Unknown tool: ${toolName}` };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
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
 * @param payload - Optional payload attachment for create_lease
 * @returns ToolResult with transaction result or error
 */
export async function executeConfirmedTool(
  toolName: string,
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  address?: string,
  signArbitrary?: (address: string, data: string) => Promise<SignResult>,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  try {
    return await executeTransaction(toolName, args, clientManager, address, signArbitrary, payload);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
