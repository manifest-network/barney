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
import type { CosmosClientManager } from 'manifest-mcp-browser';

// Storage keys
const STORAGE_KEY_SETTINGS = 'barney-ai-settings';
const STORAGE_KEY_HISTORY = 'barney-ai-history';

export interface AISettings {
  ollamaEndpoint: string;
  model: string;
  saveHistory: boolean;
  enableThinking: boolean;
}

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
  refreshModels: () => Promise<void>;
  confirmAction: () => Promise<void>;
  cancelAction: () => void;
  setClientManager: (manager: CosmosClientManager | null) => void;
  setAddress: (address: string | undefined) => void;
}

const defaultSettings: AISettings = {
  ollamaEndpoint: import.meta.env.PUBLIC_OLLAMA_URL || 'http://localhost:11434',
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

  // Load settings and history from localStorage
  useEffect(() => {
    try {
      const savedSettings = localStorage.getItem(STORAGE_KEY_SETTINGS);
      if (savedSettings) {
        const parsed = JSON.parse(savedSettings);
        setSettings({ ...defaultSettings, ...parsed });
      }

      const savedHistory = localStorage.getItem(STORAGE_KEY_HISTORY);
      if (savedHistory) {
        const parsed = JSON.parse(savedHistory);
        if (Array.isArray(parsed)) {
          setMessages(parsed);
        }
      }
    } catch (error) {
      console.error('Failed to load AI settings:', error);
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

  // Fetch available models
  const refreshModels = useCallback(async () => {
    const models = await listModels(settings.ollamaEndpoint);
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
    setSettings((prev) => ({ ...prev, ...newSettings }));
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

  // Handle tool execution
  const handleToolCall = useCallback(
    async (toolCall: OllamaToolCall): Promise<ToolResult> => {
      const result = await executeTool(toolCall.function.name, toolCall.function.arguments, {
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
      if (!content.trim() || isStreaming) return;

      // Cancel any ongoing stream
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const userMessage: ChatMessage = {
        id: generateMessageId(),
        role: 'user',
        content: content.trim(),
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
                  ? { ...m, content: resultContent, isStreaming: false }
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

        // If we hit max iterations, finalize the message
        if (iteration >= MAX_TOOL_ITERATIONS) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === currentAssistantMessageId
                ? { ...m, content: 'I reached the maximum number of tool calls. Please try a simpler request.', isStreaming: false }
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
        setIsStreaming(false);
        abortControllerRef.current = null;
      }
    },
    [messages, settings, isStreaming, toOllamaMessages, handleToolCall]
  );

  // Confirm a pending action
  const confirmAction = useCallback(async () => {
    if (!pendingConfirmation || !clientManagerRef.current) return;

    const { action, messageId } = pendingConfirmation;
    setPendingConfirmation(null);
    setIsStreaming(true);

    try {
      const result = await executeConfirmedTool(
        action.toolName,
        action.args,
        clientManagerRef.current,
        addressRef.current
      );

      const resultContent = result.success
        ? `Transaction successful!\n${JSON.stringify(result.data, null, 2)}`
        : `Transaction failed: ${result.error}`;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, content: resultContent, isStreaming: false } : m
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
      });

      let content = '';
      let thinking = '';
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
        }
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === newAssistantMessageId ? { ...m, thinking: thinking || undefined, isStreaming: false } : m
        )
      );
    } catch (error) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content: `Error executing transaction: ${error instanceof Error ? error.message : 'Unknown error'}`,
                isStreaming: false,
              }
            : m
        )
      );
    } finally {
      setIsStreaming(false);
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
