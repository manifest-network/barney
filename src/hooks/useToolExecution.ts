/**
 * Tool execution hook — handles tool call dispatch, caching, and display.
 * Extracted from AIContext to reduce file size.
 */

import { useCallback } from 'react';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import type { OllamaToolCall } from '../api/ollama';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import { getToolCallDescription, isValidToolName } from '../ai/tools';
import { executeTool, type ToolResult, type PayloadAttachment } from '../ai/toolExecutor';
import type { AppRegistryAccess, SignArbitraryFn } from '../ai/toolExecutor/types';
import type { DeployProgress } from '../ai/progress';
import type { StreamResult } from '../ai/streamUtils';
import { sanitizeToolArgs } from '../ai/validation';
import type { ChatMessage, PendingConfirmation } from '../contexts/aiTypes';
import { generateMessageId } from './useMessageManager';

export interface UseToolExecutionDeps {
  getToolCacheKey: (name: string, args: Record<string, unknown>) => string;
  getCachedToolResult: (key: string) => ToolResult | null;
  cacheToolResult: (key: string, result: ToolResult) => void;
  addMessage: (message: ChatMessage) => void;
  updateMessageById: (messageId: string, updates: Partial<ChatMessage>) => void;
  createAssistantMessage: () => ChatMessage;
  clientManagerRef: MutableRefObject<CosmosClientManager | null>;
  addressRef: MutableRefObject<string | undefined>;
  signArbitraryRef: MutableRefObject<SignArbitraryFn | undefined>;
  abortControllerRef: MutableRefObject<AbortController | null>;
  pendingPayloadRef: MutableRefObject<PayloadAttachment | null>;
  setDeployProgress: Dispatch<SetStateAction<DeployProgress | null>>;
  setPendingConfirmation: Dispatch<SetStateAction<PendingConfirmation | null>>;
  getAppRegistryAccess: () => AppRegistryAccess;
}

export type ProcessToolCallsResult =
  | { shouldContinue: false }
  | { shouldContinue: true; nextAssistantMessageId: string };

export function useToolExecution(deps: UseToolExecutionDeps) {
  const {
    getToolCacheKey, getCachedToolResult, cacheToolResult,
    addMessage, updateMessageById, createAssistantMessage,
    clientManagerRef, addressRef, signArbitraryRef, abortControllerRef, pendingPayloadRef,
    setDeployProgress, setPendingConfirmation,
    getAppRegistryAccess,
  } = deps;

  const handleToolCall = useCallback(
    async (toolCall: OllamaToolCall): Promise<ToolResult> => {
      if (!isValidToolName(toolCall.function.name)) {
        return { success: false, error: `Unknown tool: ${toolCall.function.name}` };
      }

      const sanitizedArgs = sanitizeToolArgs(toolCall.function.arguments);

      const cacheKey = getToolCacheKey(toolCall.function.name, sanitizedArgs);
      const cachedResult = getCachedToolResult(cacheKey);
      if (cachedResult) return cachedResult;

      // Clear stale deploy progress, but preserve active deploys
      setDeployProgress(prev => {
        if (!prev || prev.phase === 'ready' || prev.phase === 'failed') return null;
        return prev;
      });

      // NOTE: The abort signal is passed here but individual API calls inside tool
      // executors use withTimeout() (15s) rather than the signal for cancellation.
      // This means a user-initiated cancel during a tool call may wait up to 15s.
      // The signal is respected by the LLM stream and long-polling operations.
      const result = await executeTool(toolCall.function.name, sanitizedArgs, {
        clientManager: clientManagerRef.current,
        address: addressRef.current,
        signArbitrary: signArbitraryRef.current,
        onProgress: setDeployProgress,
        appRegistry: getAppRegistryAccess(),
        signal: abortControllerRef.current?.signal,
      }, pendingPayloadRef.current ?? undefined);

      if (result.success && !result.requiresConfirmation) {
        cacheToolResult(cacheKey, result);
      }

      return result;
    },
    [getToolCacheKey, getCachedToolResult, cacheToolResult, getAppRegistryAccess,
     clientManagerRef, addressRef, signArbitraryRef, abortControllerRef, pendingPayloadRef,
     setDeployProgress]
  );

  const executeAndDisplayToolCall = useCallback(
    async (toolCall: OllamaToolCall) => {
      const toolDescription = getToolCallDescription(toolCall.function.name, toolCall.function.arguments);

      const toolMessageId = generateMessageId();
      addMessage({
        id: toolMessageId,
        role: 'tool',
        content: toolDescription,
        toolDescription,
        timestamp: Date.now(),
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        isStreaming: true,
      });

      const result = await handleToolCall(toolCall);
      return { result, messageId: toolMessageId };
    },
    [handleToolCall, addMessage]
  );

  const processToolCalls = useCallback(
    async (
      toolCalls: OllamaToolCall[],
      currentAssistantMessageId: string,
      streamResult: StreamResult
    ): Promise<ProcessToolCallsResult> => {
      updateMessageById(currentAssistantMessageId, {
        content: streamResult.content,
        thinking: streamResult.thinking || undefined,
        toolCalls,
        isStreaming: false,
      });

      let hasDisplayCard = false;
      for (const toolCall of toolCalls) {
        const { result, messageId: toolMessageId } = await executeAndDisplayToolCall(toolCall);

        if (result.requiresConfirmation) {
          const toolName = result.pendingAction?.toolName || toolCall.function.name;
          const actionPayload = (toolName === 'deploy_app' || toolName === 'create_lease' || toolName === 'update_app')
            ? pendingPayloadRef.current ?? undefined
            : undefined;

          setPendingConfirmation({
            id: generateMessageId(),
            action: {
              id: toolCall.id,
              toolName,
              args: result.pendingAction?.args || {},
              description: result.confirmationMessage || 'Confirm action?',
              payload: actionPayload,
            },
            messageId: toolMessageId,
          });

          updateMessageById(toolMessageId, {
            content: result.confirmationMessage || 'Awaiting confirmation...',
            isStreaming: false,
          });

          return { shouldContinue: false };
        }

        if (result.success && result.displayCard) {
          hasDisplayCard = true;
          updateMessageById(toolMessageId, {
            content: JSON.stringify(result.data, null, 2),
            card: result.displayCard,
            isStreaming: false,
          });
        } else {
          const resultContent = result.success
            ? JSON.stringify(result.data, null, 2)
            : `Error: ${result.error}`;

          updateMessageById(toolMessageId, {
            content: resultContent,
            error: result.success ? undefined : result.error,
            isStreaming: false,
          });
        }
      }

      if (hasDisplayCard) {
        return { shouldContinue: false };
      }

      const newMessage = createAssistantMessage();
      addMessage(newMessage);
      return { shouldContinue: true, nextAssistantMessageId: newMessage.id };
    },
    [updateMessageById, executeAndDisplayToolCall, createAssistantMessage, addMessage, pendingPayloadRef, setPendingConfirmation]
  );

  return { handleToolCall, executeAndDisplayToolCall, processToolCalls };
}
