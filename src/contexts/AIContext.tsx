import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type ReactNode,
} from 'react';
import type { OllamaMessage, OllamaToolCall } from '../api/ollama';
import { streamChat, checkOllamaHealth, listModels, type OllamaModel } from '../api/ollama';
import { AI_TOOLS, getToolCallDescription } from '../ai/tools';
import { executeTool, executeConfirmedTool, type ToolResult, type PendingAction } from '../ai/toolExecutor';
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
import type { CosmosClientManager } from 'manifest-mcp-browser';

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
  isStreaming?: boolean;
  error?: string;
}

export interface PendingConfirmation {
  id: string;
  action: PendingAction;
  messageId: string;
}

interface AIContextType {
  // State
  isOpen: boolean;
  messages: ChatMessage[];
  isStreaming: boolean;
  isConnected: boolean;
  settings: AISettings;
  availableModels: OllamaModel[];
  pendingConfirmation: PendingConfirmation | null;

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
}

// Validate environment-provided defaults
const envEndpoint = validateEndpointUrl(import.meta.env.PUBLIC_OLLAMA_URL || '');
const defaultSettings: AISettings = {
  ollamaEndpoint: envEndpoint || 'http://localhost:11434',
  model: import.meta.env.PUBLIC_OLLAMA_MODEL || 'llama3.2',
  saveHistory: true,
  enableThinking: false,
};

const AIContext = createContext<AIContextType | null>(null);

export function AIProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [settings, setSettings] = useState<AISettings>(defaultSettings);
  const [availableModels, setAvailableModels] = useState<OllamaModel[]>([]);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);

  // Refs for client and address (to avoid re-renders)
  const clientManagerRef = useRef<CosmosClientManager | null>(null);
  const addressRef = useRef<string | undefined>(undefined);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Ref to track streaming state synchronously (prevents race conditions with rapid messages)
  const isStreamingRef = useRef(false);

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
      console.error('Failed to load AI settings:', error);
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
      console.error('Failed to save AI settings:', error);
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
        console.error('Failed to save AI history:', error);
      }
    }
  }, [messages, settings.saveHistory]);

  // Check Ollama connection
  useEffect(() => {
    const checkConnection = async () => {
      const healthy = await checkOllamaHealth(settings.ollamaEndpoint);
      setIsConnected(healthy);
    };

    checkConnection();
    const interval = setInterval(checkConnection, 30000);
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

  const setClientManager = useCallback((manager: CosmosClientManager | null) => {
    clientManagerRef.current = manager;
  }, []);

  const setAddress = useCallback((address: string | undefined) => {
    addressRef.current = address;
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
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY_HISTORY);
  }, []);

  // Generate a unique message ID
  const generateMessageId = () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

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

  // Handle tool execution with validation
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

      const result = await executeTool(toolCall.function.name, sanitizedArgs, {
        clientManager: clientManagerRef.current,
        address: addressRef.current,
      });

      return result;
    },
    []
  );

  // Send a message
  const sendMessage = useCallback(
    async (content: string) => {
      // Validate user input
      const validatedInput = validateUserInput(content);
      if (!validatedInput) return;

      // Use ref for synchronous check to prevent race conditions with rapid messages
      if (isStreamingRef.current) return;

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

      setMessages((prev) => [...prev, userMessage]);
      setIsStreaming(true);

      abortControllerRef.current = new AbortController();

      // Maximum tool call iterations to prevent infinite loops
      const MAX_TOOL_ITERATIONS = 10;
      let iteration = 0;
      let currentAssistantMessageId = generateMessageId();

      try {
        // Add initial assistant message
        setMessages((prev) => [
          ...prev,
          {
            id: currentAssistantMessageId,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            isStreaming: true,
          },
        ]);

        // Tool call loop - continues until no more tool calls or max iterations
        while (iteration < MAX_TOOL_ITERATIONS) {
          iteration++;

          // Get current messages for the API call
          const currentMessages = await new Promise<ChatMessage[]>((resolve) => {
            setMessages((prev) => {
              resolve(prev.filter((m) => m.id !== currentAssistantMessageId));
              return prev;
            });
          });

          const ollamaMessages = toOllamaMessages(currentMessages);
          let accumulatedContent = '';
          let accumulatedThinking = '';
          let toolCalls: OllamaToolCall[] = [];

          const stream = streamChat({
            endpoint: settings.ollamaEndpoint,
            model: settings.model,
            messages: ollamaMessages,
            tools: AI_TOOLS,
            think: settings.enableThinking,
            signal: abortControllerRef.current?.signal,
          });

          for await (const chunk of stream) {
            if (chunk.type === 'thinking' && chunk.content) {
              accumulatedThinking += chunk.content;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantMessageId ? { ...m, thinking: accumulatedThinking } : m
                )
              );
            } else if (chunk.type === 'content' && chunk.content) {
              accumulatedContent += chunk.content;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantMessageId ? { ...m, content: accumulatedContent } : m
                )
              );
            } else if (chunk.type === 'tool_call' && chunk.toolCall) {
              toolCalls.push(chunk.toolCall);
            } else if (chunk.type === 'error') {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantMessageId
                    ? { ...m, content: accumulatedContent, thinking: accumulatedThinking, error: chunk.error, isStreaming: false }
                    : m
                )
              );
              isStreamingRef.current = false;
              setIsStreaming(false);
              return;
            }
          }

          // If no tool calls, we're done
          if (toolCalls.length === 0) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === currentAssistantMessageId
                  ? { ...m, content: accumulatedContent, thinking: accumulatedThinking || undefined, isStreaming: false }
                  : m
              )
            );
            break;
          }

          // Update assistant message with tool calls
          setMessages((prev) =>
            prev.map((m) =>
              m.id === currentAssistantMessageId
                ? { ...m, content: accumulatedContent, thinking: accumulatedThinking || undefined, toolCalls, isStreaming: false }
                : m
            )
          );

          // Execute each tool call
          for (const toolCall of toolCalls) {
            const toolDescription = getToolCallDescription(
              toolCall.function.name,
              toolCall.function.arguments
            );

            // Add a message showing tool execution
            const toolMessageId = generateMessageId();
            setMessages((prev) => [
              ...prev,
              {
                id: toolMessageId,
                role: 'tool',
                content: toolDescription,
                timestamp: Date.now(),
                toolCallId: toolCall.id,
                toolName: toolCall.function.name,
                isStreaming: true,
              },
            ]);

            // Execute the tool
            const result = await handleToolCall(toolCall);

            if (result.requiresConfirmation) {
              // Set pending confirmation and stop the loop
              setPendingConfirmation({
                id: generateMessageId(),
                action: {
                  id: toolCall.id,
                  toolName: toolCall.function.name,
                  args: toolCall.function.arguments,
                  description: result.confirmationMessage || 'Confirm action?',
                },
                messageId: toolMessageId,
              });

              setMessages((prev) =>
                prev.map((m) =>
                  m.id === toolMessageId
                    ? {
                        ...m,
                        content: result.confirmationMessage || 'Awaiting confirmation...',
                        isStreaming: false,
                      }
                    : m
                )
              );

              isStreamingRef.current = false;
              setIsStreaming(false);
              return;
            }

            // Update tool message with result
            const resultContent = result.success
              ? JSON.stringify(result.data, null, 2)
              : `Error: ${result.error}`;

            setMessages((prev) =>
              prev.map((m) =>
                m.id === toolMessageId
                  ? {
                      ...m,
                      content: resultContent,
                      error: result.success ? undefined : result.error,
                      isStreaming: false,
                    }
                  : m
              )
            );
          }

          // Create new assistant message for next iteration
          currentAssistantMessageId = generateMessageId();
          setMessages((prev) => [
            ...prev,
            {
              id: currentAssistantMessageId,
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
              isStreaming: true,
            },
          ]);
        }

        // If we hit max iterations, finalize the message with error indicator
        if (iteration >= MAX_TOOL_ITERATIONS) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === currentAssistantMessageId
                ? {
                    ...m,
                    content: 'I reached the maximum number of tool calls for this request. This usually happens when a task requires more steps than expected. Please try breaking your request into smaller parts.',
                    error: 'max_tool_iterations_reached',
                    isStreaming: false,
                  }
                : m
            )
          );
        }
      } catch (error) {
        console.error('Error in sendMessage:', error);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === currentAssistantMessageId
              ? {
                  ...m,
                  content: 'Sorry, I encountered an error. Please try again.',
                  error: error instanceof Error ? error.message : 'Unknown error',
                  isStreaming: false,
                }
              : m
          )
        );
      } finally {
        isStreamingRef.current = false;
        setIsStreaming(false);
        abortControllerRef.current = null;
      }
    },
    [messages, settings, toOllamaMessages, handleToolCall]
  );

  // Confirm a pending action
  const confirmAction = useCallback(async () => {
    if (!pendingConfirmation || !clientManagerRef.current) return;

    // Capture refs at the start to prevent race conditions if wallet disconnects mid-execution
    const clientManager = clientManagerRef.current;
    const address = addressRef.current;

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
        address
      );

      // Keep tool message as structured JSON for the assistant to interpret
      const resultContent = JSON.stringify({
        success: result.success,
        data: result.data,
        error: result.error,
      }, null, 2);

      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content: resultContent,
                error: result.success ? undefined : result.error,
                isStreaming: false,
              }
            : m
        )
      );

      // Continue conversation to summarize result
      const newAssistantMessageId = generateMessageId();
      setMessages((prev) => [
        ...prev,
        {
          id: newAssistantMessageId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
        },
      ]);

      const updatedMessages = await new Promise<ChatMessage[]>((resolve) => {
        setMessages((prev) => {
          resolve(prev.filter((m) => m.id !== newAssistantMessageId));
          return prev;
        });
      });

      const stream = streamChat({
        endpoint: settings.ollamaEndpoint,
        model: settings.model,
        messages: toOllamaMessages(updatedMessages),
        tools: AI_TOOLS,
        think: settings.enableThinking,
        signal: abortControllerRef.current?.signal,
      });

      let content = '';
      let thinking = '';
      let streamError: string | undefined;

      for await (const chunk of stream) {
        if (chunk.type === 'thinking' && chunk.content) {
          thinking += chunk.content;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === newAssistantMessageId ? { ...m, thinking } : m
            )
          );
        } else if (chunk.type === 'content' && chunk.content) {
          content += chunk.content;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === newAssistantMessageId ? { ...m, content } : m
            )
          );
        } else if (chunk.type === 'error') {
          streamError = chunk.error;
          break;
        }
        // Note: tool_calls are intentionally not processed here since we just want
        // the assistant to summarize the transaction result, not make more tool calls
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === newAssistantMessageId
            ? {
                ...m,
                content: streamError ? `Error: ${streamError}` : content,
                thinking: thinking || undefined,
                error: streamError,
                isStreaming: false,
              }
            : m
        )
      );
    } catch (error) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content: `Error executing transaction: ${error instanceof Error ? error.message : 'Unknown error'}`,
                error: error instanceof Error ? error.message : 'Unknown error',
                isStreaming: false,
              }
            : m
        )
      );
    } finally {
      isStreamingRef.current = false;
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  }, [pendingConfirmation, settings, toOllamaMessages]);

  // Cancel a pending action
  const cancelAction = useCallback(() => {
    if (!pendingConfirmation) return;

    const { messageId } = pendingConfirmation;
    setPendingConfirmation(null);

    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? { ...m, content: 'Action cancelled by user.', isStreaming: false }
          : m
      )
    );
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
      setIsOpen,
      sendMessage,
      updateSettings,
      clearHistory,
      refreshModels,
      confirmAction,
      cancelAction,
      setClientManager,
      setAddress,
    }),
    [
      isOpen,
      messages,
      isStreaming,
      isConnected,
      settings,
      availableModels,
      pendingConfirmation,
      sendMessage,
      updateSettings,
      clearHistory,
      refreshModels,
      confirmAction,
      cancelAction,
      setClientManager,
      setAddress,
    ]
  );

  return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
}

export function useAI(): AIContextType {
  const context = useContext(AIContext);
  if (!context) {
    throw new Error('useAI must be used within an AIProvider');
  }
  return context;
}
