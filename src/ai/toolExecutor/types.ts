/**
 * Type definitions for the tool executor
 */

import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';

export interface SignResult {
  pub_key: { type: string; value: string };
  signature: string;
}

export interface PayloadAttachment {
  bytes: Uint8Array;
  filename?: string;
  size: number;
  hash: string; // Pre-computed SHA-256 hex
}

/**
 * Successful tool execution result
 */
interface ToolResultSuccess {
  success: true;
  requiresConfirmation?: false;
  data: unknown;
  error?: never;
  confirmationMessage?: never;
  pendingAction?: never;
}

/**
 * Failed tool execution result
 */
interface ToolResultFailure {
  success: false;
  requiresConfirmation?: false;
  error: string;
  data?: never;
  confirmationMessage?: never;
  pendingAction?: never;
}

/**
 * Tool result that requires user confirmation before execution
 */
interface ToolResultConfirmation {
  success: true;
  requiresConfirmation: true;
  confirmationMessage: string;
  pendingAction: {
    toolName: string;
    args: Record<string, unknown>;
  };
  data?: never;
  error?: never;
}

/**
 * Discriminated union for tool execution results.
 * - Success: { success: true, data: ... }
 * - Failure: { success: false, error: '...' }
 * - Requires confirmation: { success: true, requiresConfirmation: true, ... }
 */
export type ToolResult = ToolResultSuccess | ToolResultFailure | ToolResultConfirmation;

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
  payload?: PayloadAttachment;
}
