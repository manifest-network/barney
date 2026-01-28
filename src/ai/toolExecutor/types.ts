/**
 * Type definitions for the tool executor
 */

import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';

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
