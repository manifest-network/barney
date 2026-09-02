/**
 * sendMessage action — streaming loop for sending user messages.
 */

import { streamChat } from '../../api/morpheus';
import { buildAITools } from '../../ai/tools';
import { processStreamWithTimeout } from '../../ai/streamUtils';
import { validateUserInput } from '../../ai/validation';
import { logError } from '../../utils/errors';
import { walletIdentityMatches } from '../../utils/walletIdentity';
import {
  AI_MAX_TOOL_ITERATIONS,
  AI_STREAM_TOTAL_TIMEOUT_MS,
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
  const initialState = get();
  const {
    pendingPayload,
    isConnected,
    isStreaming,
    lastMessageTime,
    historyIdentity,
    chainId,
    address,
  } = initialState;

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
  // A wallet address can be published a render before its scoped transcript is
  // selected. Never build a model request from state unless those identities
  // match exactly.
  if (!walletIdentityMatches(historyIdentity, chainId, address)) return;

  const now = Date.now();
  if (now - lastMessageTime < AI_MESSAGE_DEBOUNCE_MS) return;

  const authorizationEpoch = get().authorizationEpoch;
  set({ lastMessageTime: now, isStreaming: true });

  // Supersede any ConfirmationCard still open from a previous turn. A pending
  // confirmation coexists with isStreaming=false while it waits for the user,
  // so without this the new turn would stream a second tx tool whose
  // confirmation overwrites the pending one via setSingleConfirmation —
  // orphaning the prior tool message (awaitingConfirmation=true with no
  // confirm/cancel path, chat wedged until reload). The UI-direct actions
  // (requestStopApp/requestBatchDeploy) gate on pendingConfirmation for the
  // same reason; the model-driven path is the remaining gap. Clearing it here
  // also lets the confirmation-timeout watcher release the prior timer.
  //
  // pendingPayload is intentionally NOT cleared here (unlike cancelActionFn):
  // the superseded confirmation's payload was snapshotted into
  // pendingConfirmation.action.payload (setSingleConfirmation) and is discarded
  // with it, and the store's pendingPayload was already nulled by the finally of
  // the turn that created the confirmation. If it is non-null now it is a FRESH
  // user attachment for THIS message — the "(File attached)" note above was
  // computed from it — so clearing it would drop the user's file and leave the
  // note pointing at a payload that no longer exists.
  const staleConfirmation = get().pendingConfirmation;
  if (staleConfirmation) {
    set({
      pendingConfirmation: null,
      messages: get().messages.map((m) =>
        m.id === staleConfirmation.messageId
          ? { ...m, content: 'Superseded by a new request — this transaction was not submitted.', error: undefined, isStreaming: false, awaitingConfirmation: false }
          : m,
      ),
    });
  }

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

      const activeState = get();
      if (activeState.authorizationEpoch !== authorizationEpoch
          || activeState.abortController !== abort
          || !walletIdentityMatches(
            activeState.historyIdentity,
            activeState.chainId,
            activeState.address,
          )) return;

      const currentMessages = activeState.messages.filter((m) => m.id !== currentAssistantMessageId);
      const { address, signing, skuTiers } = activeState;
      const apiMessages = toChatApiMessages(currentMessages, address, skuTiers.tiers);
      const tools = buildAITools(skuTiers.tiers);

      const stream = streamChat({
        messages: apiMessages,
        tools,
        signal: abort.signal,
        auth: address && signing ? {
          walletAddress: address,
          signChallenge: signing.relayAuth.signChallenge,
        } : undefined,
      });

      let totalTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const streamResult = await Promise.race([
        processStreamWithTimeout(
          stream,
          (streamContent, thinking) => {
            if (get().authorizationEpoch === authorizationEpoch
                && get().abortController === abort) {
              get().scheduleStreamingUpdate(currentAssistantMessageId, streamContent, thinking);
            }
          }
        ).finally(() => { if (totalTimeoutId) clearTimeout(totalTimeoutId); }),
        new Promise<never>((_, reject) => {
          totalTimeoutId = setTimeout(
            () => reject(new Error('Session or stream timeout: no response received')),
            AI_STREAM_TOTAL_TIMEOUT_MS,
          );
        }),
      ]);

      if (get().authorizationEpoch !== authorizationEpoch
          || get().abortController !== abort) return;

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
        streamResult,
        authorizationEpoch,
      );

      if (get().authorizationEpoch !== authorizationEpoch
          || get().abortController !== abort) return;

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
    if (get().authorizationEpoch !== authorizationEpoch
        || get().abortController !== abort) return;
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
    if (get().authorizationEpoch === authorizationEpoch
        && get().abortController === abort) {
      set({ isStreaming: false, pendingPayload: null });
      abort.abort();
      set({ abortController: null });
    }
  }
}
