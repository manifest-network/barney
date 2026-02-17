import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type ReactNode,
} from 'react';
import { AIContext } from './aiContextValue';
import type { OllamaMessage } from '../api/ollama';
import { streamChat, checkOllamaHealth, listModels, type OllamaModel } from '../api/ollama';
import { AI_TOOLS } from '../ai/tools';
import { type SignArbitraryFn, type PayloadAttachment } from '../ai/toolExecutor';
import { getSystemPrompt } from '../ai/systemPrompt';
import type { DeployProgress } from '../ai/progress';
import * as appRegistry from '../registry/appRegistry';
import { validateUserInput } from '../ai/validation';
import { logError } from '../utils/errors';
import { validateFile } from '../utils/fileValidation';
import { sha256, toHex } from '../utils/hash';
import {
  AI_MAX_TOOL_ITERATIONS,
  AI_STREAM_TIMEOUT_MS,
  AI_MESSAGE_DEBOUNCE_MS,
  AI_HEALTH_CHECK_INTERVAL_MS,
} from '../config/constants';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';

import { processStreamWithTimeout } from '../ai/streamUtils';
import { useChatPersistence, type AISettings } from '../hooks/useChatPersistence';
import { useMessageManager, generateMessageId } from '../hooks/useMessageManager';
import { useStreamingUpdates } from '../hooks/useStreamingUpdates';
import { useToolCache } from '../hooks/useToolCache';
import { useToolExecution } from '../hooks/useToolExecution';
import { useConfirmationFlow } from '../hooks/useConfirmationFlow';
import { useBatchDeploy } from '../hooks/useBatchDeploy';

// Re-export types for backward compatibility
export type { ChatMessage, PendingConfirmation } from './aiTypes';
export type { AISettings };

import type { ChatMessage } from './aiTypes';

export interface AIContextType {
  // State
  isOpen: boolean;
  messages: ChatMessage[];
  isStreaming: boolean;
  isConnected: boolean;
  settings: AISettings;
  availableModels: OllamaModel[];
  pendingConfirmation: ReturnType<typeof useConfirmationFlow>['pendingConfirmation'];
  pendingPayload: PayloadAttachment | null;
  deployProgress: DeployProgress | null;

  // Actions
  setIsOpen: (open: boolean) => void;
  sendMessage: (content: string) => Promise<void>;
  updateSettings: (settings: Partial<AISettings>) => void;
  clearHistory: () => void;
  refreshModels: (endpoint?: string) => Promise<void>;
  confirmAction: (editedManifestJson?: string) => Promise<void>;
  cancelAction: () => void;
  setClientManager: (manager: CosmosClientManager | null) => void;
  setAddress: (address: string | undefined) => void;
  setSignArbitrary: (fn: SignArbitraryFn | undefined) => void;
  attachPayload: (file: File) => Promise<{ error?: string }>;
  clearPayload: () => void;
  requestBatchDeploy: (apps: Array<{ label: string; manifest: object }>, userMessage?: string) => Promise<void>;
  addLocalMessage: (content: string, card?: { type: string; data: unknown }) => void;
  stopStreaming: () => void;
}

export function AIProvider({ children }: { children: ReactNode }) {
  // --- Refs ---
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
  const [pendingPayload, setPendingPayload] = useState<PayloadAttachment | null>(null);
  const [deployProgress, setDeployProgress] = useState<DeployProgress | null>(null);

  // --- App registry access (shared by extracted hooks) ---

  const getAppRegistryAccess = useCallback(() => ({
    getApps: appRegistry.getApps,
    getApp: appRegistry.getApp,
    findApp: appRegistry.findApp,
    getAppByLease: appRegistry.getAppByLease,
    addApp: appRegistry.addApp,
    updateApp: appRegistry.updateApp,
  }), []);

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

  // --- Confirmation flow (owns pendingConfirmation state) ---

  const { pendingConfirmation, setPendingConfirmation, confirmAction, cancelAction } = useConfirmationFlow({
    isStreamingRef, abortControllerRef,
    clientManagerRef, addressRef, signArbitraryRef,
    pendingPayloadRef, setPendingPayload,
    setIsStreaming, setDeployProgress,
    messagesRef, setMessages,
    updateMessageById, createAssistantMessage, addMessage, getCurrentMessages,
    scheduleStreamingUpdate, flushPendingUpdate,
    settings, toOllamaMessages, getAppRegistryAccess,
  });

  // --- Tool execution ---

  const { processToolCalls } = useToolExecution({
    getToolCacheKey, getCachedToolResult, cacheToolResult,
    addMessage, updateMessageById, createAssistantMessage,
    clientManagerRef, addressRef, signArbitraryRef, abortControllerRef, pendingPayloadRef,
    setDeployProgress, setPendingConfirmation,
    getAppRegistryAccess,
  });

  // --- Batch deploy ---

  const { requestBatchDeploy } = useBatchDeploy({
    isStreamingRef, setIsStreaming, isConnected,
    clientManagerRef, addressRef, signArbitraryRef,
    addMessage, updateMessageById,
    setDeployProgress, setPendingConfirmation,
    getAppRegistryAccess,
  });

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

  // --- History ---

  const clearHistory = useCallback(() => {
    messagesRef.current = [];
    clearHistoryBase();
    clearToolCache();
  }, [messagesRef, clearHistoryBase, clearToolCache]);

  // --- Send message ---

  const sendMessage = useCallback(
    async (content: string) => {
      const payload = pendingPayloadRef.current;
      let effectiveContent = content;
      if (payload) {
        const attachNote = `(File attached: ${payload.filename})`;
        effectiveContent = content.trim()
          ? `${content.trim()} ${attachNote}`
          : `Deploy this ${attachNote}`;
      }

      const validatedInput = validateUserInput(effectiveContent);
      if (!validatedInput) return;
      if (!isConnected) return;
      if (isStreamingRef.current) return;

      // Simple timestamp guard — intentionally not extracted to a useDebounce hook
      // since this is the only debounce site in the codebase.
      const now = Date.now();
      if (now - lastMessageTimeRef.current < AI_MESSAGE_DEBOUNCE_MS) return;
      lastMessageTimeRef.current = now;

      isStreamingRef.current = true;

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
      setDeployProgress(prev => {
        if (!prev || prev.phase === 'ready' || prev.phase === 'failed') return null;
        return prev;
      });

      abortControllerRef.current = new AbortController();

      let iteration = 0;
      const initialAssistantMessage = createAssistantMessage();
      let currentAssistantMessageId = initialAssistantMessage.id;

      try {
        addMessage(initialAssistantMessage);

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

          // Two-layer timeout (intentionally not consolidated):
          //  1. processStreamWithTimeout: per-chunk timeout catches hung connections mid-stream
          //  2. Outer safety net (AI_STREAM_TIMEOUT_MS * 2): catches streams that never start
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

          if (streamResult.error) {
            updateMessageById(currentAssistantMessageId, {
              content: streamResult.content,
              thinking: streamResult.thinking || undefined,
              error: streamResult.error,
              isStreaming: false,
            });
            return;
          }

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

          const toolResult = await processToolCalls(
            streamResult.toolCalls,
            currentAssistantMessageId,
            streamResult
          );

          if (!toolResult.shouldContinue) return;
          currentAssistantMessageId = toolResult.nextAssistantMessageId;
        }

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

  // --- Stop streaming ---

  const stopStreaming = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  // --- Local message injection ---

  const addLocalMessage = useCallback((content: string, card?: { type: string; data: unknown }) => {
    addMessage({
      id: generateMessageId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      card,
    });
  }, [addMessage]);

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
      addLocalMessage,
      stopStreaming,
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
      addLocalMessage,
      stopStreaming,
    ]
  );

  return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
}
