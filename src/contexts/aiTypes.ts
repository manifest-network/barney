/**
 * Shared types for the AI context and related hooks.
 * Extracted to avoid circular dependencies between AIContext and custom hooks.
 */

import type { ToolCall } from '../api/morpheus';
import type { PendingAction } from '../ai/toolExecutor';

/** Data for a logs display card. */
export interface LogsCardData {
  app_name: string;
  logs: Record<string, string>;
  truncated: boolean;
}

/** Discriminated union for message display cards. */
export type MessageCard =
  | { type: 'logs'; data: LogsCardData }
  | { type: 'help'; data: null };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  toolDescription?: string;
  isStreaming?: boolean;
  error?: string;
  card?: MessageCard;
}

export interface PendingConfirmation {
  id: string;
  action: PendingAction;
  messageId: string;
}
