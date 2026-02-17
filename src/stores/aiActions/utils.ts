/**
 * Shared utilities for store actions.
 */

import type { OllamaMessage } from '../../api/ollama';
import type { ChatMessage } from '../../contexts/aiTypes';
import { getSystemPrompt } from '../../ai/systemPrompt';
import { AI_MAX_MESSAGES } from '../../config/constants';
import * as appRegistry from '../../registry/appRegistry';
import type { AppRegistryAccess } from '../../ai/toolExecutor/types';

export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function trimMessages(msgs: ChatMessage[]): ChatMessage[] {
  if (msgs.length <= AI_MAX_MESSAGES) return msgs;
  return msgs.slice(-AI_MAX_MESSAGES);
}

export function createAssistantMessage(): ChatMessage {
  return {
    id: generateMessageId(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    isStreaming: true,
  };
}

export function toOllamaMessages(msgs: ChatMessage[], address: string | undefined): OllamaMessage[] {
  const systemMessage: OllamaMessage = {
    role: 'system',
    content: getSystemPrompt(address),
  };

  const conversationMessages: OllamaMessage[] = msgs
    .filter((m) => !m.isStreaming)
    .map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content,
          tool_call_id: m.toolCallId,
        };
      }
      return {
        role: m.role as 'user' | 'assistant',
        content: m.content,
        tool_calls: m.toolCalls,
      };
    });

  return [systemMessage, ...conversationMessages];
}

export function getAppRegistryAccess(): AppRegistryAccess {
  return {
    getApps: appRegistry.getApps,
    getApp: appRegistry.getApp,
    findApp: appRegistry.findApp,
    getAppByLease: appRegistry.getAppByLease,
    addApp: appRegistry.addApp,
    updateApp: appRegistry.updateApp,
  };
}
