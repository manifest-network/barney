/**
 * sendMessage action — streaming loop for sending user messages.
 */

import { streamChat } from '../../api/morpheus';
import { runtimeConfig } from '../../config/runtimeConfig';
import { AI_TOOLS } from '../../ai/tools';
import { processStreamWithTimeout } from '../../ai/streamUtils';
import { validateUserInput } from '../../ai/validation';
import { logError } from '../../utils/errors';
import {
  AI_MAX_TOOL_ITERATIONS,
  AI_STREAM_TIMEOUT_MS,
  AI_MESSAGE_DEBOUNCE_MS,
} from '../../config/constants';
import type { AIStore } from '../aiStore';
import { processToolCallsFn } from './toolExecution';
import {
  generateMessageId,
  trimMessages,
  createAssistantMessage,
  toChatApiMessages,
} from './utils';

type Get = () => AIStore;
type Set = (partial: Partial<AIStore> | ((state: AIStore) => Partial<AIStore>)) => void;

export async function sendMessageFn(get: Get, set: Set, content: string): Promise<void> {
  const { pendingPayload, isConnected, isStreaming, lastMessageTime } = get();

  let effectiveContent = content;
  if (pendingPayload) {
    const attachNote = `(File attached: ${pendingPayload.filename})`;
    effectiveContent = content.trim()
      ? `${content.trim()} ${attachNote}`
      : `Deploy this ${attachNote}`;
  }

  const validatedInput = validateUserInput(effectiveContent);
  if (!validatedInput) return;
  if (!isConnected) return;
  if (isStreaming) return;

  const now = Date.now();
  if (now - lastMessageTime < AI_MESSAGE_DEBOUNCE_MS) return;

  set({ lastMessageTime: now, isStreaming: true });

  const { abortController: oldAbort } = get();
  if (oldAbort) {
    oldAbort.abort();
  }

  const userMessage = {
    id: generateMessageId(),
    role: 'user' as const,
    content: validatedInput,
    timestamp: Date.now(),
  };

  set({ messages: trimMessages([...get().messages, userMessage]) });

  // Clear stale deploy progress
  const { deployProgress } = get();
  if (!deployProgress || deployProgress.phase === 'ready' || deployProgress.phase === 'failed') {
    set({ deployProgress: null });
  }

  const abort = new AbortController();
  set({ abortController: abort });

  let iteration = 0;
  const initialAssistantMessage = createAssistantMessage();
  let currentAssistantMessageId = initialAssistantMessage.id;

  try {
    set({ messages: trimMessages([...get().messages, initialAssistantMessage]) });

    while (iteration < AI_MAX_TOOL_ITERATIONS) {
      iteration++;

      const currentMessages = get().messages.filter((m) => m.id !== currentAssistantMessageId);
      const { settings, address } = get();
      const apiMessages = toChatApiMessages(currentMessages, address);

      const stream = streamChat({
        apiUrl: settings.morpheusUrl,
        apiKey: runtimeConfig.PUBLIC_MORPHEUS_API_KEY,
        model: settings.model,
        messages: apiMessages,
        tools: AI_TOOLS,
        signal: get().abortController?.signal,
      });

      let totalTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const streamResult = await Promise.race([
        processStreamWithTimeout(
          stream,
          (streamContent, thinking) => {
            get().scheduleStreamingUpdate(currentAssistantMessageId, streamContent, thinking);
          }
        ).finally(() => { if (totalTimeoutId) clearTimeout(totalTimeoutId); }),
        new Promise<never>((_, reject) => {
          totalTimeoutId = setTimeout(
            () => reject(new Error('Stream timeout: no response received')),
            AI_STREAM_TIMEOUT_MS * 2
          );
        }),
      ]);

      get().flushPendingUpdate();

      if (streamResult.error) {
        const updated = get().messages.map((m) =>
          m.id === currentAssistantMessageId
            ? { ...m, content: streamResult.content, thinking: streamResult.thinking || undefined, error: streamResult.error, isStreaming: false }
            : m
        );
        set({ messages: updated });
        return;
      }

      if (streamResult.toolCalls.length === 0) {
        const finalContent = streamResult.content.trim() ||
          'I received your message but couldn\'t generate a response. This may indicate the model doesn\'t support tool calling.';
        const updated = get().messages.map((m) =>
          m.id === currentAssistantMessageId
            ? {
                ...m,
                content: finalContent,
                thinking: streamResult.thinking || undefined,
                isStreaming: false,
                error: streamResult.content.trim() ? undefined : 'empty_response',
              }
            : m
        );
        set({ messages: updated });
        break;
      }

      const toolResult = await processToolCallsFn(
        get,
        set,
        streamResult.toolCalls,
        currentAssistantMessageId,
        streamResult
      );

      if (!toolResult.shouldContinue) return;
      currentAssistantMessageId = toolResult.nextAssistantMessageId;
    }

    if (iteration >= AI_MAX_TOOL_ITERATIONS) {
      const updated = get().messages.map((m) =>
        m.id === currentAssistantMessageId
          ? {
              ...m,
              content: 'I reached the maximum number of tool calls for this request. This usually happens when a task requires more steps than expected. Please try breaking your request into smaller parts.',
              error: 'max_tool_iterations_reached',
              isStreaming: false,
            }
          : m
      );
      set({ messages: updated });
    }
  } catch (error) {
    logError('AIContext.sendMessage', error);
    const updated = get().messages.map((m) =>
      m.id === currentAssistantMessageId
        ? {
            ...m,
            content: error instanceof Error && error.message.includes('timeout')
              ? 'The AI server took too long to respond. Please try again.'
              : 'Sorry, I encountered an error. Please try again.',
            error: error instanceof Error ? error.message : 'Unknown error',
            isStreaming: false,
          }
        : m
    );
    set({ messages: updated });
  } finally {
    set({ isStreaming: false, pendingPayload: null });
    get().abortController?.abort();
    set({ abortController: null });
  }
}
