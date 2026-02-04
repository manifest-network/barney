import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type ReactNode,
} from 'react';
import { AIContext } from './aiContextValue';
import type { OllamaMessage, OllamaToolCall, OllamaStreamChunk } from '../api/ollama';
import { streamChat, checkOllamaHealth, listModels, type OllamaModel } from '../api/ollama';
import { AI_TOOLS, getToolCallDescription } from '../ai/tools';
import { executeTool, executeConfirmedTool, type ToolResult, type PendingAction, type SignResult, type PayloadAttachment } from '../ai/toolExecutor';
import { getSystemPrompt } from '../ai/systemPrompt';
import {
  validateSettings,
  validateChatHistory,
  validateEndpointUrl,
  validateUserInput,
  isValidToolName,
  sanitizeToolArgs,
  type AISettings,
} from '../ai/validation';
import { logError } from '../utils/errors';
import { validateFile } from '../utils/fileValidation';
import { sha256, toHex } from '../utils/hash';
import {
  AI_MAX_MESSAGES,
  AI_MAX_TOOL_ITERATIONS,
  AI_STREAM_TIMEOUT_MS,
  AI_MESSAGE_DEBOUNCE_MS,
  AI_HEALTH_CHECK_INTERVAL_MS,
  AI_CONFIRMATION_TIMEOUT_MS,
  AI_TOOL_CACHE_TTL_MS,
  AI_TOOL_CACHE_MAX_SIZE,
} from '../config/constants';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';

/**
 * Result of processing a stream to completion
 */
interface StreamResult {
  content: string;
  thinking: string;
  toolCalls: OllamaToolCall[];
  error?: string;
}

/**
 * Process stream chunks with timeout protection
 * Throws TimeoutError if no chunk received within timeout period
 */
async function processStreamWithTimeout(
  stream: AsyncGenerator<OllamaStreamChunk>,
  onChunk: (content: string, thinking: string) => void,
  timeoutMs: number = AI_STREAM_TIMEOUT_MS
): Promise<StreamResult> {
  let accumulatedContent = '';
  let accumulatedThinking = '';
  const toolCalls: OllamaToolCall[] = [];

  for await (const chunk of withTimeout(stream, timeoutMs)) {
    if (chunk.type === 'thinking' && chunk.content) {
      accumulatedThinking += chunk.content;
      onChunk(accumulatedContent, accumulatedThinking);
    } else if (chunk.type === 'content' && chunk.content) {
      accumulatedContent += chunk.content;
      onChunk(accumulatedContent, accumulatedThinking);
    } else if (chunk.type === 'tool_call' && chunk.toolCall) {
      toolCalls.push(chunk.toolCall);
    } else if (chunk.type === 'error') {
      return {
        content: accumulatedContent,
        thinking: accumulatedThinking,
        toolCalls,
        error: chunk.error,
      };
    }
  }

  return { content: accumulatedContent, thinking: accumulatedThinking, toolCalls };
}

/**
 * Wrap an async generator with timeout protection per iteration
 */
async function* withTimeout<T>(
  generator: AsyncGenerator<T>,
  timeoutMs: number
): AsyncGenerator<T> {
  while (true) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const result = await Promise.race([
        generator.next(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('Stream timeout: no response received')),
            timeoutMs
          );
        }),
      ]);

      if (result.done) break;
      yield result.value;
    } finally {
      // Clear the timeout to avoid accumulating orphan timers
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }
}

// Storage keys
const STORAGE_KEY_SETTINGS = 'barney-ai-settings';
const STORAGE_KEY_HISTORY = 'barney-ai-history';

export type { AISettings };

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
}

export interface PendingConfirmation {
  id: string;
  action: PendingAction;
  messageId: string;
}

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
}

// Validate environment-provided defaults
const envEndpoint = validateEndpointUrl(import.meta.env.PUBLIC_OLLAMA_URL || '');
const defaultSettings: AISettings = {
  ollamaEndpoint: envEndpoint || 'http://localhost:11434',
  model: import.meta.env.PUBLIC_OLLAMA_MODEL || 'llama3.2',
  saveHistory: true,
  enableThinking: false,
};


export function AIProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [settings, setSettings] = useState<AISettings>(defaultSettings);
  const [availableModels, setAvailableModels] = useState<OllamaModel[]>([]);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [pendingPayload, setPendingPayload] = useState<PayloadAttachment | null>(null);
  const pendingPayloadRef = useRef<PayloadAttachment | null>(null);

  // Refs for client, address, and signing (to avoid re-renders)
  const clientManagerRef = useRef<CosmosClientManager | null>(null);
  const addressRef = useRef<string | undefined>(undefined);
  const signArbitraryRef = useRef<SignArbitraryFn | undefined>(undefined);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Ref to track streaming state synchronously (prevents race conditions with rapid messages)
  const isStreamingRef = useRef(false);
  // Ref for throttling streaming updates (reduces re-renders during streaming)
  const pendingUpdateRef = useRef<{
    messageId: string;
    content: string;
    thinking: string;
  } | null>(null);
  const rafIdRef = useRef<number | null>(null);
  // Ref to track last message timestamp for debouncing rapid sends
  const lastMessageTimeRef = useRef<number>(0);
  // Ref to track current messages for synchronous access in async operations
  const messagesRef = useRef<ChatMessage[]>([]);
  // Cache for query tool results to reduce redundant API calls
  const toolCacheRef = useRef<Map<string, { result: ToolResult; timestamp: number }>>(new Map());

  // Load settings and history from localStorage with validation
  useEffect(() => {
    try {
      const savedSettings = localStorage.getItem(STORAGE_KEY_SETTINGS);
      if (savedSettings) {
        const parsed = JSON.parse(savedSettings);
        // Validate and sanitize settings from localStorage
        const validated = validateSettings(parsed);
        setSettings({ ...defaultSettings, ...validated });
      }

      const savedHistory = localStorage.getItem(STORAGE_KEY_HISTORY);
      if (savedHistory) {
        const parsed = JSON.parse(savedHistory);
        // Validate and sanitize chat history from localStorage
        const validated = validateChatHistory(parsed) as ChatMessage[];
        setMessages(validated);
      }
    } catch (error) {
      logError('AIContext.loadSettings', error);
      // On parse error, clear potentially corrupted data
      localStorage.removeItem(STORAGE_KEY_SETTINGS);
      localStorage.removeItem(STORAGE_KEY_HISTORY);
    }
  }, []);

  // Save settings to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
    } catch (error) {
      logError('AIContext.saveSettings', error);
    }
  }, [settings]);

  // Save history to localStorage (if enabled)
  useEffect(() => {
    if (settings.saveHistory) {
      try {
        // Only save non-streaming messages
        const toSave = messages.filter((m) => !m.isStreaming);
        localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(toSave));
      } catch (error) {
        logError('AIContext.saveHistory', error);
      }
    }
  }, [messages, settings.saveHistory]);

  // Keep messagesRef in sync with messages state for synchronous access
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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

  // Cleanup abort controller and RAF on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
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

  const setClientManager = useCallback((manager: CosmosClientManager | null) => {
    clientManagerRef.current = manager;
  }, []);

  const setAddress = useCallback((address: string | undefined) => {
    // Clear cached query results when wallet changes to prevent serving stale data
    if (address !== addressRef.current) {
      toolCacheRef.current.clear();
    }
    addressRef.current = address;
  }, []);

  const setSignArbitrary = useCallback((fn: SignArbitraryFn | undefined) => {
    signArbitraryRef.current = fn;
  }, []);

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
    } catch {
      return { error: 'Failed to read file' };
    }
  }, []);

  const clearPayload = useCallback(() => {
    pendingPayloadRef.current = null;
    setPendingPayload(null);
  }, []);

  const updateSettings = useCallback((newSettings: Partial<AISettings>) => {
    setSettings((prev) => {
      const updated = { ...prev };

      // Validate endpoint URL if provided
      if (newSettings.ollamaEndpoint !== undefined) {
        const validatedUrl = validateEndpointUrl(newSettings.ollamaEndpoint);
        if (validatedUrl) {
          updated.ollamaEndpoint = validatedUrl;
        }
        // If invalid, keep the previous value
      }

      // Validate and copy other settings
      if (typeof newSettings.model === 'string' && newSettings.model.length > 0) {
        updated.model = newSettings.model;
      }
      if (typeof newSettings.saveHistory === 'boolean') {
        updated.saveHistory = newSettings.saveHistory;
      }
      if (typeof newSettings.enableThinking === 'boolean') {
        updated.enableThinking = newSettings.enableThinking;
      }

      return updated;
    });
  }, []);

  const clearHistory = useCallback(() => {
    messagesRef.current = [];
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY_HISTORY);
    // Clear tool cache when history is cleared
    toolCacheRef.current.clear();
  }, []);

  // Generate a unique message ID
  const generateMessageId = () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // Trim messages to AI_MAX_MESSAGES limit (keeps most recent)
  const trimMessages = useCallback((msgs: ChatMessage[]): ChatMessage[] => {
    if (msgs.length <= AI_MAX_MESSAGES) return msgs;
    // Keep the most recent messages
    return msgs.slice(-AI_MAX_MESSAGES);
  }, []);

  // Helper to update a message by ID
  // Updates ref synchronously BEFORE setMessages to avoid race conditions
  const updateMessageById = useCallback(
    (messageId: string, updates: Partial<ChatMessage>) => {
      const updated = messagesRef.current.map((m) => (m.id === messageId ? { ...m, ...updates } : m));
      messagesRef.current = updated;
      setMessages(updated);
    },
    []
  );

  // Helper to add a new message
  // Updates ref synchronously BEFORE setMessages to avoid race conditions
  const addMessage = useCallback(
    (message: ChatMessage) => {
      const updated = trimMessages([...messagesRef.current, message]);
      messagesRef.current = updated;
      setMessages(updated);
    },
    [trimMessages]
  );

  // Helper to create an assistant message
  const createAssistantMessage = useCallback((): ChatMessage => {
    return {
      id: generateMessageId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };
  }, []);

  // Helper to get current messages (excluding a specific message ID)
  // Uses ref for synchronous access without setState anti-pattern
  const getCurrentMessages = useCallback(
    (excludeId?: string): ChatMessage[] => {
      const current = messagesRef.current;
      return excludeId ? current.filter((m) => m.id !== excludeId) : current;
    },
    []
  );

  // Flush any pending streaming update immediately
  const flushPendingUpdate = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const pending = pendingUpdateRef.current;
    if (pending) {
      setMessages((prev) => {
        const updated = prev.map((m) =>
          m.id === pending.messageId
            ? { ...m, content: pending.content, thinking: pending.thinking || undefined }
            : m
        );
        messagesRef.current = updated;
        return updated;
      });
      pendingUpdateRef.current = null;
    }
  }, []);

  // Schedule a throttled update for streaming content (once per animation frame)
  const scheduleStreamingUpdate = useCallback((messageId: string, content: string, thinking: string) => {
    pendingUpdateRef.current = { messageId, content, thinking };

    if (!rafIdRef.current) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        const pending = pendingUpdateRef.current;
        if (pending) {
          setMessages((prev) => {
            const updated = prev.map((m) =>
              m.id === pending.messageId
                ? { ...m, content: pending.content, thinking: pending.thinking || undefined }
                : m
            );
            messagesRef.current = updated;
            return updated;
          });
          pendingUpdateRef.current = null;
        }
      });
    }
  }, []);

  // Convert chat messages to Ollama format
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

  // Generate cache key for tool calls (includes address to prevent cross-wallet stale hits)
  const getToolCacheKey = useCallback((toolName: string, args: Record<string, unknown>): string => {
    const addr = addressRef.current ?? '';
    // Sort keys for consistent cache key regardless of arg order
    const sortedArgs = Object.keys(args).sort().reduce((acc, key) => {
      acc[key] = args[key];
      return acc;
    }, {} as Record<string, unknown>);
    return `${addr}:${toolName}:${JSON.stringify(sortedArgs)}`;
  }, []);

  // Check if cached result is still valid
  const getCachedToolResult = useCallback((cacheKey: string): ToolResult | null => {
    const cached = toolCacheRef.current.get(cacheKey);
    if (!cached) return null;

    const isExpired = Date.now() - cached.timestamp > AI_TOOL_CACHE_TTL_MS;
    if (isExpired) {
      toolCacheRef.current.delete(cacheKey);
      return null;
    }

    return cached.result;
  }, []);

  // Handle tool execution with validation and caching
  const handleToolCall = useCallback(
    async (toolCall: OllamaToolCall): Promise<ToolResult> => {
      // Validate tool name
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

      const result = await executeTool(toolCall.function.name, sanitizedArgs, {
        clientManager: clientManagerRef.current,
        address: addressRef.current,
      });

      // Cache successful query results (not confirmations or failures)
      // Transaction tools return requiresConfirmation=true, so they won't be cached
      if (result.success && !result.requiresConfirmation) {
        // Evict oldest entries if cache is full
        if (toolCacheRef.current.size >= AI_TOOL_CACHE_MAX_SIZE) {
          const entries = Array.from(toolCacheRef.current.entries());
          entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
          // Remove oldest 10% of entries
          const toRemove = Math.max(1, Math.floor(AI_TOOL_CACHE_MAX_SIZE * 0.1));
          for (let i = 0; i < toRemove; i++) {
            toolCacheRef.current.delete(entries[i][0]);
          }
        }
        toolCacheRef.current.set(cacheKey, { result, timestamp: Date.now() });
      }

      return result;
    },
    [getToolCacheKey, getCachedToolResult]
  );

  // Execute a single tool call and update UI
  const executeAndDisplayToolCall = useCallback(
    async (toolCall: OllamaToolCall): Promise<{ result: ToolResult; messageId: string }> => {
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

      // Execute the tool
      const result = await handleToolCall(toolCall);
      return { result, messageId: toolMessageId };
    },
    [handleToolCall, addMessage]
  );

  // Process tool calls and return whether to continue the loop
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
      for (const toolCall of toolCalls) {
        const { result, messageId: toolMessageId } = await executeAndDisplayToolCall(toolCall);

        if (result.requiresConfirmation) {
          // Capture pending payload at confirmation time for create_lease
          const toolName = result.pendingAction?.toolName || toolCall.function.name;
          const actionPayload = toolName === 'create_lease' ? pendingPayloadRef.current ?? undefined : undefined;

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
        const resultContent = result.success
          ? JSON.stringify(result.data, null, 2)
          : `Error: ${result.error}`;

        updateMessageById(toolMessageId, {
          content: resultContent,
          error: result.success ? undefined : result.error,
          isStreaming: false,
        });
      }

      // Create new assistant message for next iteration
      const newMessage = createAssistantMessage();
      addMessage(newMessage);
      return { shouldContinue: true, nextAssistantMessageId: newMessage.id };
    },
    [updateMessageById, executeAndDisplayToolCall, createAssistantMessage, addMessage]
  );

  // Send a message
  const sendMessage = useCallback(
    async (content: string) => {
      // Validate user input
      const validatedInput = validateUserInput(content);
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

      abortControllerRef.current = new AbortController();

      let iteration = 0;
      const initialAssistantMessage = createAssistantMessage();
      let currentAssistantMessageId = initialAssistantMessage.id;

      try {
        // Add initial assistant message
        addMessage(initialAssistantMessage);

        // Tool call loop - continues until no more tool calls or max iterations
        while (iteration < AI_MAX_TOOL_ITERATIONS) {
          iteration++;

          // Get current messages for the API call
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

          // Process stream with timeout protection
          const streamResult = await processStreamWithTimeout(
            stream,
            (content, thinking) => {
              scheduleStreamingUpdate(currentAssistantMessageId, content, thinking);
            }
          );

          // Flush any pending throttled updates before finalizing
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
            updateMessageById(currentAssistantMessageId, {
              content: streamResult.content,
              thinking: streamResult.thinking || undefined,
              isStreaming: false,
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
        // Abort any ongoing fetch to prevent connection leaks
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
      }
    },
    [isConnected, settings, toOllamaMessages, addMessage, createAssistantMessage, getCurrentMessages, updateMessageById, processToolCalls, scheduleStreamingUpdate, flushPendingUpdate]
  );

  // Confirm a pending action
  const confirmAction = useCallback(async () => {
    // Guard against concurrent executions (UI also disables buttons, but this is defensive)
    if (!pendingConfirmation || isStreamingRef.current) return;

    // Check if wallet is connected - if not, show error and clear pending state
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

    // Set up abort controller for the follow-up stream
    abortControllerRef.current = new AbortController();

    try {
      const result = await executeConfirmedTool(
        action.toolName,
        action.args,
        clientManager,
        address,
        signArbitrary,
        action.payload
      );

      // Keep tool message as structured JSON for the assistant to interpret
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

      // Don't pass tools - we just want the assistant to summarize the result, not make more tool calls
      const stream = streamChat({
        endpoint: settings.ollamaEndpoint,
        model: settings.model,
        messages: toOllamaMessages(updatedMessages),
        think: settings.enableThinking,
        signal: abortControllerRef.current?.signal,
      });

      // Process stream with timeout protection
      const streamResult = await processStreamWithTimeout(
        stream,
        (content, thinking) => {
          scheduleStreamingUpdate(newAssistantMessage.id, content, thinking);
        }
      );

      // Flush any pending throttled updates before finalizing
      flushPendingUpdate();

      updateMessageById(newAssistantMessage.id, {
        content: streamResult.error ? `Error: ${streamResult.error}` : streamResult.content,
        thinking: streamResult.thinking || undefined,
        error: streamResult.error,
        isStreaming: false,
      });
    } catch (error) {
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
      // Abort any ongoing fetch to prevent connection leaks
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      // Clear payload attachment after execution
      pendingPayloadRef.current = null;
      setPendingPayload(null);
    }
  }, [pendingConfirmation, settings, toOllamaMessages, updateMessageById, createAssistantMessage, addMessage, getCurrentMessages, scheduleStreamingUpdate, flushPendingUpdate]);

  // Cancel a pending action
  const cancelAction = useCallback(() => {
    if (!pendingConfirmation) return;

    const { messageId } = pendingConfirmation;
    setPendingConfirmation(null);
    // Clear payload attachment on cancel
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
  }, [pendingConfirmation]);

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
  }, [pendingConfirmation]);

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
    ]
  );

  return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
}

