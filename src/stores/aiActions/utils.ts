/**
 * Shared utilities for store actions.
 */

import type { ChatApiMessage } from '../../api/morpheus';
import type { ChatMessage } from '../../contexts/aiTypes';
import { getSystemPrompt } from '../../ai/systemPrompt';
import { AI_MAX_MESSAGES } from '../../config/constants';
import * as appRegistry from '../../registry/appRegistry';
import type { AppRegistryAccess } from '../../ai/toolExecutor/types';
import type { ResolvedSkuTier } from '../../api/skuTiers';

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

export function toChatApiMessages(
  msgs: ChatMessage[],
  address: string | undefined,
  tiers: readonly ResolvedSkuTier[] = [],
): ChatApiMessage[] {
  const systemMessage: ChatApiMessage = {
    role: 'system',
    content: getSystemPrompt(address, tiers),
  };

  const conversationMessages: ChatApiMessage[] = msgs
    // Drop streaming-in-progress messages and UI-synthesized messages (e.g. /help text).
    // Local messages render in chat but must not be replayed to the model — otherwise
    // the model treats its own canned UI strings as prior assistant output.
    .filter((m) => !m.isStreaming && !m.local)
    .map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content,
          tool_call_id: m.toolCallId,
        };
      }
      // Some OpenAI-compatible backends require assistant messages with tool_calls
      // to have non-empty content. Use a placeholder when content is empty.
      const content = (m.toolCalls?.length && !m.content) ? 'Calling tools.' : m.content;
      return {
        role: m.role as 'user' | 'assistant',
        content,
        tool_calls: m.toolCalls,
      };
    });

  // Some models (e.g. Mistral) reject tool→user transitions without an
  // intermediate assistant message. Insert a synthetic one when needed.
  const fixed: ChatApiMessage[] = [];
  for (let i = 0; i < conversationMessages.length; i++) {
    fixed.push(conversationMessages[i]);
    if (
      conversationMessages[i].role === 'tool' &&
      i + 1 < conversationMessages.length &&
      conversationMessages[i + 1].role === 'user'
    ) {
      fixed.push({ role: 'assistant', content: 'Tool execution complete.' });
    }
  }

  return [systemMessage, ...fixed];
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
