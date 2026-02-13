/**
 * Confirmation flow hook — manages TX confirmation, cancellation, and timeout.
 * Extracted from AIContext to reduce file size.
 */

import { useState, useCallback, useEffect } from 'react';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import type { OllamaMessage } from '../api/ollama';
import { streamChat } from '../api/ollama';
import { executeConfirmedTool, type PayloadAttachment } from '../ai/toolExecutor';
import type { AppRegistryAccess, SignResult } from '../ai/toolExecutor/types';
import type { DeployProgress } from '../ai/progress';
import { processStreamWithTimeout } from '../ai/streamUtils';
import { logError } from '../utils/errors';
import { AI_CONFIRMATION_TIMEOUT_MS } from '../config/constants';
import type { ChatMessage, PendingConfirmation } from '../contexts/aiTypes';
import type { AISettings } from './useChatPersistence';

type SignArbitraryFn = (address: string, data: string) => Promise<SignResult>;

export interface UseConfirmationFlowDeps {
  isStreamingRef: MutableRefObject<boolean>;
  abortControllerRef: MutableRefObject<AbortController | null>;
  clientManagerRef: MutableRefObject<CosmosClientManager | null>;
  addressRef: MutableRefObject<string | undefined>;
  signArbitraryRef: MutableRefObject<SignArbitraryFn | undefined>;
  pendingPayloadRef: MutableRefObject<PayloadAttachment | null>;
  setPendingPayload: Dispatch<SetStateAction<PayloadAttachment | null>>;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  setDeployProgress: Dispatch<SetStateAction<DeployProgress | null>>;
  messagesRef: MutableRefObject<ChatMessage[]>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  updateMessageById: (messageId: string, updates: Partial<ChatMessage>) => void;
  createAssistantMessage: () => ChatMessage;
  addMessage: (message: ChatMessage) => void;
  getCurrentMessages: (excludeId?: string) => ChatMessage[];
  scheduleStreamingUpdate: (messageId: string, content: string, thinking?: string) => void;
  flushPendingUpdate: () => void;
  settings: AISettings;
  toOllamaMessages: (msgs: ChatMessage[]) => OllamaMessage[];
  getAppRegistryAccess: () => AppRegistryAccess;
}

export function useConfirmationFlow(deps: UseConfirmationFlowDeps) {
  const {
    isStreamingRef, abortControllerRef,
    clientManagerRef, addressRef, signArbitraryRef,
    pendingPayloadRef, setPendingPayload,
    setIsStreaming, setDeployProgress,
    messagesRef, setMessages,
    updateMessageById, createAssistantMessage, addMessage, getCurrentMessages,
    scheduleStreamingUpdate, flushPendingUpdate,
    settings, toOllamaMessages, getAppRegistryAccess,
  } = deps;

  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);

  const confirmAction = useCallback(async (editedManifestJson?: string) => {
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

    const clientManager = clientManagerRef.current;
    const address = addressRef.current;
    const signArbitrary = signArbitraryRef.current;
    const { messageId } = pendingConfirmation;

    // Clone action to avoid mutating React state; apply user edits if present
    let confirmedArgs = pendingConfirmation.action.args;
    let confirmedPayload = pendingConfirmation.action.payload;
    if (editedManifestJson && confirmedArgs._generatedManifest) {
      confirmedArgs = { ...confirmedArgs, _generatedManifest: editedManifestJson };
      confirmedPayload = undefined; // force executor to reconstruct from edited JSON
    }
    const action = { ...pendingConfirmation.action, args: confirmedArgs, payload: confirmedPayload };

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
          signal: abortControllerRef.current?.signal,
        },
        action.payload
      );

      // For simple operations (restart/update), clear progress on failure
      // so only the inline error card + LLM summary are shown.
      // For deploys, preserve progress so the phase stepper remains visible.
      if (!result.success) {
        const isSimple = action.toolName === 'restart_app' || action.toolName === 'update_app';
        if (isSimple) {
          setDeployProgress(null);
        }
      }

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
  }, [pendingConfirmation, settings, toOllamaMessages, updateMessageById, createAssistantMessage, addMessage, getCurrentMessages, scheduleStreamingUpdate, flushPendingUpdate, getAppRegistryAccess, isStreamingRef, abortControllerRef, clientManagerRef, addressRef, signArbitraryRef, pendingPayloadRef, setPendingPayload, setIsStreaming, setDeployProgress]);

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
  }, [pendingConfirmation, setMessages, messagesRef, pendingPayloadRef, setPendingPayload]);

  // Auto-cancel pending confirmations after timeout
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
  }, [pendingConfirmation, setMessages, messagesRef, pendingPayloadRef, setPendingPayload]);

  return { pendingConfirmation, setPendingConfirmation, confirmAction, cancelAction };
}
