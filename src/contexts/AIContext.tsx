import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type ReactNode,
} from 'react';
import { AIContext } from './aiContextValue';
import type { OllamaMessage, OllamaToolCall } from '../api/ollama';
import { streamChat, checkOllamaHealth, listModels, type OllamaModel } from '../api/ollama';
import { AI_TOOLS, getToolCallDescription, isValidToolName } from '../ai/tools';
import { executeTool, executeConfirmedTool, type SignResult, type PayloadAttachment } from '../ai/toolExecutor';
import { executeBatchDeploy, deriveAppName } from '../ai/toolExecutor/compositeTransactions';
import { getSystemPrompt } from '../ai/systemPrompt';
import type { DeployProgress } from '../ai/progress';
import * as appRegistry from '../registry/appRegistry';
import { validateUserInput, sanitizeToolArgs } from '../ai/validation';
import { logError } from '../utils/errors';
import { validateFile } from '../utils/fileValidation';
import { sha256, toHex } from '../utils/hash';
import {
  AI_MAX_TOOL_ITERATIONS,
  AI_STREAM_TIMEOUT_MS,
  AI_MESSAGE_DEBOUNCE_MS,
  AI_HEALTH_CHECK_INTERVAL_MS,
  AI_CONFIRMATION_TIMEOUT_MS,
} from '../config/constants';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';

import { processStreamWithTimeout } from '../ai/streamUtils';
import type { StreamResult } from '../ai/streamUtils';
import { useChatPersistence, type AISettings } from '../hooks/useChatPersistence';
import { useMessageManager, generateMessageId } from '../hooks/useMessageManager';
import { useStreamingUpdates } from '../hooks/useStreamingUpdates';
import { useToolCache } from '../hooks/useToolCache';

// Re-export types for backward compatibility
export type { ChatMessage, PendingConfirmation } from './aiTypes';
export type { AISettings };

import type { ChatMessage, PendingConfirmation } from './aiTypes';

type SignArbitraryFn = (address: string, data: string) => Promise<SignResult>;

export interface AIContextType {
  // State
  isOpen: boolean;
  messages: ChatMessage[];
  isStreaming: boolean;
  isConnected: boolean;
  settings: AISettings;
  availableModels: OllamaModel[];
  pendingConfirmation: PendingConfirmation | null;
  pendingPayload: PayloadAttachment | null;
  deployProgress: DeployProgress | null;

  // Actions
  setIsOpen: (open: boolean) => void;
  sendMessage: (content: string) => Promise<void>;
  updateSettings: (settings: Partial<AISettings>) => void;
  clearHistory: () => void;
  refreshModels: (endpoint?: string) => Promise<void>;
  confirmAction: () => Promise<void>;
  cancelAction: () => void;
  setClientManager: (manager: CosmosClientManager | null) => void;
  setAddress: (address: string | undefined) => void;
  setSignArbitrary: (fn: SignArbitraryFn | undefined) => void;
  attachPayload: (file: File) => Promise<{ error?: string }>;
  clearPayload: () => void;
  requestBatchDeploy: (apps: Array<{ label: string; manifest: object }>, userMessage?: string) => Promise<void>;
}

export function AIProvider({ children }: { children: ReactNode }) {
  // --- Refs (defined first so hooks can reference them) ---
  const clientManagerRef = useRef<CosmosClientManager | null>(null);
  const addressRef = useRef<string | undefined>(undefined);
  const signArbitraryRef = useRef<SignArbitraryFn | undefined>(undefined);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isStreamingRef = useRef(false);
  const lastMessageTimeRef = useRef<number>(0);
  const pendingPayloadRef = useRef<PayloadAttachment | null>(null);

  // --- Extracted hooks ---
  const { settings, updateSettings, messages, setMessages, clearHistory: clearHistoryBase } = useChatPersistence();
  const { messagesRef, addMessage, updateMessageById, getCurrentMessages, createAssistantMessage } = useMessageManager(messages, setMessages);
  const { scheduleStreamingUpdate, flushPendingUpdate } = useStreamingUpdates(setMessages, messagesRef);
  const { getToolCacheKey, getCachedToolResult, cacheToolResult, clearCache: clearToolCache } = useToolCache(addressRef);

  // --- Local state ---
  const [isOpen, setIsOpen] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [availableModels, setAvailableModels] = useState<OllamaModel[]>([]);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [pendingPayload, setPendingPayload] = useState<PayloadAttachment | null>(null);
  const [deployProgress, setDeployProgress] = useState<DeployProgress | null>(null);

  // --- Effects ---

  // Check Ollama connection
  useEffect(() => {
    const checkConnection = async () => {
      const healthy = await checkOllamaHealth(settings.ollamaEndpoint);
      setIsConnected(healthy);
    };

    checkConnection();
    const interval = setInterval(checkConnection, AI_HEALTH_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [settings.ollamaEndpoint]);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  // Fetch available models
  const refreshModels = useCallback(async (endpoint?: string) => {
    const models = await listModels(endpoint || settings.ollamaEndpoint);
    setAvailableModels(models);
  }, [settings.ollamaEndpoint]);

  useEffect(() => {
    refreshModels();
  }, [refreshModels]);

  // --- Wallet setters ---

  const setClientManager = useCallback((manager: CosmosClientManager | null) => {
    clientManagerRef.current = manager;
  }, []);

  const setSignArbitrary = useCallback((fn: SignArbitraryFn | undefined) => {
    signArbitraryRef.current = fn;
  }, []);

  const setAddress = useCallback((address: string | undefined) => {
    // Clear cached query results when wallet changes to prevent serving stale data
    if (address !== addressRef.current) {
      clearToolCache();
      setDeployProgress(null);
    }
    addressRef.current = address;
  }, [clearToolCache]);

  // --- Payload attachment ---

  const attachPayload = useCallback(async (file: File): Promise<{ error?: string }> => {
    const validation = validateFile(file);
    if (!validation.valid) {
      return { error: validation.error };
    }

    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const hashBytes = await sha256(bytes);
      const hash = toHex(hashBytes);

      const attachment: PayloadAttachment = {
        bytes,
        filename: file.name,
        size: file.size,
        hash,
      };

      pendingPayloadRef.current = attachment;
      setPendingPayload(attachment);
      return {};
    } catch (error) {
      logError('AIContext.attachPayload', error);
      return { error: 'Failed to read file' };
    }
  }, []);

  const clearPayload = useCallback(() => {
    pendingPayloadRef.current = null;
    setPendingPayload(null);
  }, []);

  // --- History (wraps extracted hook + clears tool cache) ---

  const clearHistory = useCallback(() => {
    messagesRef.current = [];
    clearHistoryBase();
    clearToolCache();
  }, [messagesRef, clearHistoryBase, clearToolCache]);

  // --- Ollama message conversion ---

  const toOllamaMessages = useCallback((msgs: ChatMessage[]): OllamaMessage[] => {
    const systemMessage: OllamaMessage = {
      role: 'system',
      content: getSystemPrompt(addressRef.current),
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
  }, []);

  // --- App registry access (shared by tool execution callbacks) ---

  const getAppRegistryAccess = useCallback(() => ({
    getApps: appRegistry.getApps,
    getApp: appRegistry.getApp,
    findApp: appRegistry.findApp,
    getAppByLease: appRegistry.getAppByLease,
    addApp: appRegistry.addApp,
    updateApp: appRegistry.updateApp,
  }), []);

  // --- Tool execution ---

  const handleToolCall = useCallback(
    async (toolCall: OllamaToolCall) => {
      // Validate tool name against composite tools
      if (!isValidToolName(toolCall.function.name)) {
        return {
          success: false,
          error: `Unknown tool: ${toolCall.function.name}`,
        };
      }

      // Sanitize arguments
      const sanitizedArgs = sanitizeToolArgs(toolCall.function.arguments);

      // Check cache for query tools (only query tools are cacheable)
      const cacheKey = getToolCacheKey(toolCall.function.name, sanitizedArgs);
      const cachedResult = getCachedToolResult(cacheKey);
      if (cachedResult) {
        return cachedResult;
      }

      // Clear deploy progress on new tool call
      setDeployProgress(null);

      const result = await executeTool(toolCall.function.name, sanitizedArgs, {
        clientManager: clientManagerRef.current,
        address: addressRef.current,
        signArbitrary: signArbitraryRef.current,
        onProgress: setDeployProgress,
        appRegistry: getAppRegistryAccess(),
      }, pendingPayloadRef.current ?? undefined);

      // Cache successful query results (not confirmations or failures)
      if (result.success && !result.requiresConfirmation) {
        cacheToolResult(cacheKey, result);
      }

      return result;
    },
    [getToolCacheKey, getCachedToolResult, cacheToolResult, getAppRegistryAccess]
  );

  const executeAndDisplayToolCall = useCallback(
    async (toolCall: OllamaToolCall) => {
      const toolDescription = getToolCallDescription(
        toolCall.function.name,
        toolCall.function.arguments
      );

      // Add a message showing tool execution
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
    ): Promise<{ shouldContinue: boolean; nextAssistantMessageId?: string }> => {
      // Update assistant message with tool calls
      updateMessageById(currentAssistantMessageId, {
        content: streamResult.content,
        thinking: streamResult.thinking || undefined,
        toolCalls,
        isStreaming: false,
      });

      // Execute each tool call
      let hasDisplayCard = false;
      for (const toolCall of toolCalls) {
        const { result, messageId: toolMessageId } = await executeAndDisplayToolCall(toolCall);

        if (result.requiresConfirmation) {
          // Capture pending payload at confirmation time for deploy_app/create_lease
          const toolName = result.pendingAction?.toolName || toolCall.function.name;
          const actionPayload = (toolName === 'deploy_app' || toolName === 'create_lease')
            ? pendingPayloadRef.current ?? undefined
            : undefined;

          // Set pending confirmation and stop the loop
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

        // Update tool message with result
        if (result.success && result.displayCard) {
          hasDisplayCard = true;
          updateMessageById(toolMessageId, {
            content: '',
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

      // Skip LLM round-trip when results were rendered directly as cards
      if (hasDisplayCard) {
        return { shouldContinue: false };
      }

      // Create new assistant message for next iteration
      const newMessage = createAssistantMessage();
      addMessage(newMessage);
      return { shouldContinue: true, nextAssistantMessageId: newMessage.id };
    },
    [updateMessageById, executeAndDisplayToolCall, createAssistantMessage, addMessage]
  );

  // --- Send message ---

  const sendMessage = useCallback(
    async (content: string) => {
      // Build effective content: include attachment info so the model knows about the file
      const payload = pendingPayloadRef.current;
      let effectiveContent = content;
      if (payload) {
        const attachNote = `(File attached: ${payload.filename})`;
        effectiveContent = content.trim()
          ? `${content.trim()} ${attachNote}`
          : `Deploy this ${attachNote}`;
      }

      // Validate user input
      const validatedInput = validateUserInput(effectiveContent);
      if (!validatedInput) return;

      // Don't send if not connected to Ollama
      if (!isConnected) return;

      // Use ref for synchronous check to prevent race conditions with rapid messages
      if (isStreamingRef.current) return;

      // Debounce rapid message sends
      const now = Date.now();
      if (now - lastMessageTimeRef.current < AI_MESSAGE_DEBOUNCE_MS) {
        return;
      }
      lastMessageTimeRef.current = now;

      // Mark as streaming synchronously before any async operations
      isStreamingRef.current = true;

      // Cancel any ongoing stream
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const userMessage: ChatMessage = {
        id: generateMessageId(),
        role: 'user',
        content: validatedInput,
        timestamp: Date.now(),
      };

      addMessage(userMessage);
      setIsStreaming(true);
      setDeployProgress(null);

      abortControllerRef.current = new AbortController();

      let iteration = 0;
      const initialAssistantMessage = createAssistantMessage();
      let currentAssistantMessageId = initialAssistantMessage.id;

      try {
        addMessage(initialAssistantMessage);

        // Tool call loop - continues until no more tool calls or max iterations
        while (iteration < AI_MAX_TOOL_ITERATIONS) {
          iteration++;

          const currentMessages = getCurrentMessages(currentAssistantMessageId);
          const ollamaMessages = toOllamaMessages(currentMessages);

          const stream = streamChat({
            endpoint: settings.ollamaEndpoint,
            model: settings.model,
            messages: ollamaMessages,
            tools: AI_TOOLS,
            think: settings.enableThinking,
            signal: abortControllerRef.current?.signal,
          });

          // Process stream with timeout protection.
          // Two layers: per-chunk timeout inside processStreamWithTimeout,
          // plus an overall timeout here as a safety net.
          let totalTimeoutId: ReturnType<typeof setTimeout> | undefined;
          const streamResult = await Promise.race([
            processStreamWithTimeout(
              stream,
              (content, thinking) => {
                scheduleStreamingUpdate(currentAssistantMessageId, content, thinking);
              }
            ).finally(() => { if (totalTimeoutId) clearTimeout(totalTimeoutId); }),
            new Promise<never>((_, reject) => {
              totalTimeoutId = setTimeout(
                () => reject(new Error('Stream timeout: no response received')),
                AI_STREAM_TIMEOUT_MS * 2
              );
            }),
          ]);

          flushPendingUpdate();

          // Handle stream error
          if (streamResult.error) {
            updateMessageById(currentAssistantMessageId, {
              content: streamResult.content,
              thinking: streamResult.thinking || undefined,
              error: streamResult.error,
              isStreaming: false,
            });
            return;
          }

          // If no tool calls, we're done
          if (streamResult.toolCalls.length === 0) {
            const finalContent = streamResult.content.trim() ||
              'I received your message but couldn\'t generate a response. This may indicate the model doesn\'t support tool calling. Please check that your Ollama model supports function calling (e.g., llama3.1, mistral-nemo, qwen2.5).';
            updateMessageById(currentAssistantMessageId, {
              content: finalContent,
              thinking: streamResult.thinking || undefined,
              isStreaming: false,
              error: streamResult.content.trim() ? undefined : 'empty_response',
            });
            break;
          }

          // Process tool calls
          const { shouldContinue, nextAssistantMessageId } = await processToolCalls(
            streamResult.toolCalls,
            currentAssistantMessageId,
            streamResult
          );

          if (!shouldContinue) {
            return; // Pending confirmation or error
          }

          currentAssistantMessageId = nextAssistantMessageId!;
        }

        // If we hit max iterations, finalize the message with error indicator
        if (iteration >= AI_MAX_TOOL_ITERATIONS) {
          updateMessageById(currentAssistantMessageId, {
            content: 'I reached the maximum number of tool calls for this request. This usually happens when a task requires more steps than expected. Please try breaking your request into smaller parts.',
            error: 'max_tool_iterations_reached',
            isStreaming: false,
          });
        }
      } catch (error) {
        logError('AIContext.sendMessage', error);
        updateMessageById(currentAssistantMessageId, {
          content: error instanceof Error && error.message.includes('timeout')
            ? 'The AI server took too long to respond. Please check that Ollama is running and try again.'
            : 'Sorry, I encountered an error. Please try again.',
          error: error instanceof Error ? error.message : 'Unknown error',
          isStreaming: false,
        });
      } finally {
        isStreamingRef.current = false;
        setIsStreaming(false);
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
      }
    },
    [isConnected, settings, toOllamaMessages, addMessage, createAssistantMessage, getCurrentMessages, updateMessageById, processToolCalls, scheduleStreamingUpdate, flushPendingUpdate]
  );

  // --- Confirmation flow ---

  const confirmAction = useCallback(async () => {
    if (!pendingConfirmation || isStreamingRef.current) return;

    if (!clientManagerRef.current) {
      const { messageId } = pendingConfirmation;
      setPendingConfirmation(null);
      updateMessageById(messageId, {
        content: 'Wallet disconnected. Please reconnect your wallet and try again.',
        error: 'wallet_disconnected',
        isStreaming: false,
      });
      return;
    }

    // Capture refs at the start to prevent race conditions if wallet disconnects mid-execution
    const clientManager = clientManagerRef.current;
    const address = addressRef.current;
    const signArbitrary = signArbitraryRef.current;

    const { action, messageId } = pendingConfirmation;
    setPendingConfirmation(null);
    isStreamingRef.current = true;
    setIsStreaming(true);

    abortControllerRef.current = new AbortController();

    try {
      setDeployProgress(null);

      const result = await executeConfirmedTool(
        action.toolName,
        action.args,
        clientManager,
        {
          clientManager,
          address,
          signArbitrary,
          onProgress: setDeployProgress,
          appRegistry: getAppRegistryAccess(),
        },
        action.payload
      );

      const resultContent = JSON.stringify({
        success: result.success,
        data: result.data,
        error: result.error,
      }, null, 2);

      updateMessageById(messageId, {
        content: resultContent,
        error: result.success ? undefined : result.error,
        isStreaming: false,
      });

      // Continue conversation to summarize result
      const newAssistantMessage = createAssistantMessage();
      addMessage(newAssistantMessage);

      const updatedMessages = getCurrentMessages(newAssistantMessage.id);

      // Don't pass tools - we just want the assistant to summarize the result
      const stream = streamChat({
        endpoint: settings.ollamaEndpoint,
        model: settings.model,
        messages: toOllamaMessages(updatedMessages),
        think: settings.enableThinking,
        signal: abortControllerRef.current?.signal,
      });

      const streamResult = await processStreamWithTimeout(
        stream,
        (content, thinking) => {
          scheduleStreamingUpdate(newAssistantMessage.id, content, thinking);
        }
      );

      flushPendingUpdate();

      updateMessageById(newAssistantMessage.id, {
        content: streamResult.error ? `Error: ${streamResult.error}` : streamResult.content,
        thinking: streamResult.thinking || undefined,
        error: streamResult.error,
        isStreaming: false,
      });
    } catch (error) {
      logError('AIContext.confirmAction', error);
      const errorMessage = error instanceof Error && error.message.includes('timeout')
        ? 'The AI server took too long to respond. The transaction may have completed - please check your wallet.'
        : `Error executing transaction: ${error instanceof Error ? error.message : 'Unknown error'}`;

      updateMessageById(messageId, {
        content: errorMessage,
        error: error instanceof Error ? error.message : 'Unknown error',
        isStreaming: false,
      });
    } finally {
      isStreamingRef.current = false;
      setIsStreaming(false);
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      pendingPayloadRef.current = null;
      setPendingPayload(null);
    }
  }, [pendingConfirmation, settings, toOllamaMessages, updateMessageById, createAssistantMessage, addMessage, getCurrentMessages, scheduleStreamingUpdate, flushPendingUpdate, getAppRegistryAccess]);

  const cancelAction = useCallback(() => {
    if (!pendingConfirmation) return;

    const { messageId } = pendingConfirmation;
    setPendingConfirmation(null);
    pendingPayloadRef.current = null;
    setPendingPayload(null);

    setMessages((prev) => {
      const updated = prev.map((m) =>
        m.id === messageId
          ? { ...m, content: 'Action cancelled by user.', isStreaming: false }
          : m
      );
      messagesRef.current = updated;
      return updated;
    });
  }, [pendingConfirmation, setMessages, messagesRef]);

  // Auto-cancel pending confirmations after timeout to prevent indefinite waiting
  useEffect(() => {
    if (!pendingConfirmation) return;

    const timeoutId = setTimeout(() => {
      const { messageId } = pendingConfirmation;
      setPendingConfirmation(null);
      pendingPayloadRef.current = null;
      setPendingPayload(null);

      setMessages((prev) => {
        const updated = prev.map((m) =>
          m.id === messageId
            ? { ...m, content: `Action timed out - confirmation not received within ${AI_CONFIRMATION_TIMEOUT_MS / 60000} minutes.`, isStreaming: false, error: 'timeout' }
            : m
        );
        messagesRef.current = updated;
        return updated;
      });

      logError('AIContext.confirmationTimeout', new Error('Pending confirmation timed out'));
    }, AI_CONFIRMATION_TIMEOUT_MS);

    return () => clearTimeout(timeoutId);
  }, [pendingConfirmation, setMessages, messagesRef]);

  // --- Batch deploy ---

  const requestBatchDeploy = useCallback(async (apps: Array<{ label: string; manifest: object }>, originalMessage?: string) => {
    if (isStreamingRef.current || !isConnected) return;
    isStreamingRef.current = true;
    setIsStreaming(true);

    let toolMsgId: string | undefined;
    try {
      const names = apps.map((a) => a.label);
      const userMessage: ChatMessage = {
        id: generateMessageId(),
        role: 'user',
        content: originalMessage || `Deploy ${names.join(', ')}`,
        timestamp: Date.now(),
      };
      addMessage(userMessage);
      setDeployProgress(null);

      // Add synthetic assistant message with tool_calls so the LLM
      // sees a well-formed conversation when summarizing after confirmation.
      const syntheticToolCallId = generateMessageId();
      addMessage({
        id: generateMessageId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [{
          id: syntheticToolCallId,
          type: 'function',
          function: { name: 'batch_deploy', arguments: {} },
        }],
      });

      toolMsgId = generateMessageId();
      addMessage({
        id: toolMsgId,
        role: 'tool',
        content: 'Validating batch deploy...',
        toolName: 'batch_deploy',
        toolCallId: syntheticToolCallId,
        toolDescription: `Deploying ${names.join(', ')}`,
        timestamp: Date.now(),
        isStreaming: true,
      });

      // Create payloads for each app
      const entries = await Promise.all(apps.map(async (app) => {
        const filename = `manifest-${app.label.toLowerCase().replace(/[^a-z0-9]/g, '-')}.json`;
        const blob = new Blob([JSON.stringify(app.manifest, null, 2)], { type: 'application/json' });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const hashBytes = await sha256(bytes);
        const hash = toHex(hashBytes);
        return {
          app_name: deriveAppName(filename),
          payload: { bytes, filename, size: blob.size, hash },
        };
      }));

      const result = await executeBatchDeploy(entries, {
        clientManager: clientManagerRef.current,
        address: addressRef.current,
        signArbitrary: signArbitraryRef.current,
        onProgress: setDeployProgress,
        appRegistry: getAppRegistryAccess(),
      });

      if (result.requiresConfirmation) {
        setPendingConfirmation({
          id: generateMessageId(),
          action: {
            id: 'batch',
            toolName: 'batch_deploy',
            args: result.pendingAction!.args,
            description: result.confirmationMessage!,
          },
          messageId: toolMsgId,
        });
        updateMessageById(toolMsgId, { content: result.confirmationMessage!, isStreaming: false });
      } else {
        updateMessageById(toolMsgId, {
          content: `Error: ${result.error}`,
          error: result.error,
          isStreaming: false,
        });
      }
    } catch (error) {
      logError('AIContext.requestBatchDeploy', error);
      if (toolMsgId) {
        updateMessageById(toolMsgId, {
          content: `Batch deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error: error instanceof Error ? error.message : 'Unknown error',
          isStreaming: false,
        });
      }
    } finally {
      isStreamingRef.current = false;
      setIsStreaming(false);
    }
  }, [isConnected, addMessage, updateMessageById, getAppRegistryAccess]);

  // --- Context value ---

  const value = useMemo(
    () => ({
      isOpen,
      messages,
      isStreaming,
      isConnected,
      settings,
      availableModels,
      pendingConfirmation,
      pendingPayload,
      deployProgress,
      setIsOpen,
      sendMessage,
      updateSettings,
      clearHistory,
      refreshModels,
      confirmAction,
      cancelAction,
      setClientManager,
      setAddress,
      setSignArbitrary,
      attachPayload,
      clearPayload,
      requestBatchDeploy,
    }),
    [
      isOpen,
      messages,
      isStreaming,
      isConnected,
      settings,
      availableModels,
      pendingConfirmation,
      pendingPayload,
      deployProgress,
      sendMessage,
      updateSettings,
      clearHistory,
      refreshModels,
      confirmAction,
      cancelAction,
      setClientManager,
      setAddress,
      setSignArbitrary,
      attachPayload,
      clearPayload,
      requestBatchDeploy,
    ]
  );

  return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
}
