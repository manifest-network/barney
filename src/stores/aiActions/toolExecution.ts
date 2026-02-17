/**
 * Tool execution actions — dispatches tool calls, handles caching and display.
 */

import type { OllamaToolCall } from '../../api/ollama';
import { getToolCallDescription, isValidToolName } from '../../ai/tools';
import { executeTool, type ToolResult } from '../../ai/toolExecutor';
import { sanitizeToolArgs } from '../../ai/validation';
import type { StreamResult } from '../../ai/streamUtils';
import type { AIStore } from '../aiStore';
import {
  generateMessageId,
  trimMessages,
  createAssistantMessage,
  getAppRegistryAccess,
} from './utils';

type Get = () => AIStore;
type Set = (partial: Partial<AIStore> | ((state: AIStore) => Partial<AIStore>)) => void;

export type ProcessToolCallsResult =
  | { shouldContinue: false }
  | { shouldContinue: true; nextAssistantMessageId: string };

async function handleToolCall(
  get: Get,
  set: Set,
  toolCall: OllamaToolCall,
): Promise<ToolResult> {
  if (!isValidToolName(toolCall.function.name)) {
    return { success: false, error: `Unknown tool: ${toolCall.function.name}` };
  }

  const sanitizedArgs = sanitizeToolArgs(toolCall.function.arguments);

  const cacheKey = get().getToolCacheKey(toolCall.function.name, sanitizedArgs);
  const cachedResult = get().getCachedToolResult(cacheKey);
  if (cachedResult) return cachedResult;

  // Clear stale deploy progress, but preserve active deploys
  const { deployProgress } = get();
  if (!deployProgress || deployProgress.phase === 'ready' || deployProgress.phase === 'failed') {
    set({ deployProgress: null });
  }

  const { clientManager, address, signArbitrary, abortController, pendingPayload } = get();

  const result = await executeTool(toolCall.function.name, sanitizedArgs, {
    clientManager,
    address,
    signArbitrary,
    onProgress: (progress) => set({ deployProgress: { ...progress } }),
    appRegistry: getAppRegistryAccess(),
    signal: abortController?.signal,
  }, pendingPayload ?? undefined);

  if (result.success && !result.requiresConfirmation) {
    get().cacheToolResult(cacheKey, result);
  }

  return result;
}

export async function processToolCallsFn(
  get: Get,
  set: Set,
  toolCalls: OllamaToolCall[],
  currentAssistantMessageId: string,
  streamResult: StreamResult,
): Promise<ProcessToolCallsResult> {
  // Update the assistant message with the stream result
  const updated1 = get().messages.map((m) =>
    m.id === currentAssistantMessageId
      ? { ...m, content: streamResult.content, thinking: streamResult.thinking || undefined, toolCalls, isStreaming: false }
      : m
  );
  set({ messages: updated1 });

  let hasDisplayCard = false;
  for (const toolCall of toolCalls) {
    const toolDescription = getToolCallDescription(toolCall.function.name, toolCall.function.arguments);
    const toolMessageId = generateMessageId();

    // Add tool message
    const toolMsg = {
      id: toolMessageId,
      role: 'tool' as const,
      content: toolDescription,
      toolDescription,
      timestamp: Date.now(),
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      isStreaming: true,
    };
    set({ messages: trimMessages([...get().messages, toolMsg]) });

    const result = await handleToolCall(get, set, toolCall);

    if (result.requiresConfirmation) {
      const toolName = result.pendingAction?.toolName || toolCall.function.name;
      const actionPayload = (toolName === 'deploy_app' || toolName === 'create_lease' || toolName === 'update_app')
        ? get().pendingPayload ?? undefined
        : undefined;

      set({
        pendingConfirmation: {
          id: generateMessageId(),
          action: {
            id: toolCall.id,
            toolName,
            args: result.pendingAction?.args || {},
            description: result.confirmationMessage || 'Confirm action?',
            payload: actionPayload,
          },
          messageId: toolMessageId,
        },
      });

      // Update tool message
      const updated = get().messages.map((m) =>
        m.id === toolMessageId
          ? { ...m, content: result.confirmationMessage || 'Awaiting confirmation...', isStreaming: false }
          : m
      );
      set({ messages: updated });

      return { shouldContinue: false };
    }

    if (result.success && result.displayCard) {
      hasDisplayCard = true;
      const updated = get().messages.map((m) =>
        m.id === toolMessageId
          ? { ...m, content: JSON.stringify(result.data, null, 2), card: result.displayCard, isStreaming: false }
          : m
      );
      set({ messages: updated });
    } else {
      const resultContent = result.success
        ? JSON.stringify(result.data, null, 2)
        : `Error: ${result.error}`;

      const updated = get().messages.map((m) =>
        m.id === toolMessageId
          ? { ...m, content: resultContent, error: result.success ? undefined : result.error, isStreaming: false }
          : m
      );
      set({ messages: updated });
    }
  }

  if (hasDisplayCard) {
    return { shouldContinue: false };
  }

  const newMessage = createAssistantMessage();
  set({ messages: trimMessages([...get().messages, newMessage]) });
  return { shouldContinue: true, nextAssistantMessageId: newMessage.id };
}
