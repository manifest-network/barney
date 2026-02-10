/**
 * Shared types for the AI context and related hooks.
 * Extracted to avoid circular dependencies between AIContext and custom hooks.
 */

import type { OllamaToolCall } from '../api/ollama';
import type { PendingAction } from '../ai/toolExecutor';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  timestamp: number;
  toolCalls?: OllamaToolCall[];
  toolCallId?: string;
  toolName?: string;
  toolDescription?: string;
  isStreaming?: boolean;
  error?: string;
  card?: { type: string; data: unknown };
}

export interface PendingConfirmation {
  id: string;
  action: PendingAction;
  messageId: string;
}
