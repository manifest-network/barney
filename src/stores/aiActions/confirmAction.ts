/**
 * Confirmation flow actions — TX confirmation, cancellation, and timeout.
 */

import { streamChat } from '../../api/morpheus';
import { executeConfirmedTool } from '../../ai/toolExecutor';
import { processStreamWithTimeout } from '../../ai/streamUtils';
import { logError } from '../../utils/errors';
import { bigIntReplacer } from '../../utils/json';
import { isApex } from '../../utils/customDomainValidation';
import type { AIStore } from '../aiStore';
import { generateMessageId, toChatApiMessages, getAppRegistryAccess } from './utils';

const APEX_WARNING =
  'This is an apex domain. CNAMEs at the apex are not allowed by RFC; use ALIAS / ANAME / CNAME-flattening (Cloudflare) at your registrar.';

type Get = () => AIStore;
type Set = (partial: Partial<AIStore> | ((state: AIStore) => Partial<AIStore>)) => void;

export interface ConfirmActionOverrides {
  editedManifestJson?: string;
  editedCustomDomain?: string;
  editedCustomDomainServiceName?: string;
}

export async function confirmActionFn(get: Get, set: Set, overrides?: ConfirmActionOverrides): Promise<void> {
  const { pendingConfirmation, isStreaming, clientManager } = get();
  if (!pendingConfirmation || isStreaming) return;

  if (!clientManager) {
    const { messageId } = pendingConfirmation;
    set({ pendingConfirmation: null });
    const updated = get().messages.map((m) =>
      m.id === messageId
        ? { ...m, content: 'Wallet disconnected. Please reconnect your wallet and try again.', error: 'wallet_disconnected', isStreaming: false }
        : m
    );
    set({ messages: updated });
    return;
  }

  const { address, signArbitrary } = get();
  const { messageId } = pendingConfirmation;

  // Clone action to avoid mutating React state; apply user edits if present.
  let confirmedArgs = pendingConfirmation.action.args;
  let confirmedPayload = pendingConfirmation.action.payload;
  if (overrides?.editedManifestJson && confirmedArgs._generatedManifest) {
    confirmedArgs = { ...confirmedArgs, _generatedManifest: overrides.editedManifestJson };
    confirmedPayload = undefined;
  }
  // For deploy_app, allow the user to add/edit/clear the custom_domain at confirm time.
  // The pending args carry whatever the AI prefilled; the override is what's in the
  // input field at the moment of confirmation. Empty string = no domain attached.
  if (overrides && pendingConfirmation.action.toolName === 'deploy_app' &&
      overrides.editedCustomDomain !== undefined) {
    const domain = overrides.editedCustomDomain.trim().replace(/\.$/, '').toLowerCase();
    const serviceName = overrides.editedCustomDomainServiceName ?? '';
    if (domain === '') {
      // Drop the domain-related keys entirely; deploy proceeds without attach.
      const { customDomain: _cd, customDomainServiceName: _csn, customDomainWarning: _cw, ...rest } = confirmedArgs;
      void _cd; void _csn; void _cw;
      confirmedArgs = rest;
    } else {
      // Recompute the apex warning synchronously on the edited value so the
      // post-broadcast success-message wording (and ConfirmationCard apex hint)
      // stays in sync with whatever the user typed. The async chain-Params
      // reserved-suffix check doesn't re-run here; the chain rejects
      // authoritatively if the domain falls in a reserved zone.
      const customDomainWarning = isApex(domain) ? APEX_WARNING : undefined;
      confirmedArgs = {
        ...confirmedArgs,
        customDomain: domain,
        customDomainServiceName: serviceName,
        customDomainWarning,
      };
    }
  }
  const action = { ...pendingConfirmation.action, args: confirmedArgs, payload: confirmedPayload };

  set({ pendingConfirmation: null, isStreaming: true });

  const abort = new AbortController();
  set({ abortController: abort });

  try {
    set({ deployProgress: null });

    const result = await executeConfirmedTool(
      action.toolName,
      action.args,
      clientManager,
      {
        clientManager,
        address,
        signArbitrary,
        onProgress: (progress) => set({ deployProgress: { ...progress } }),
        appRegistry: getAppRegistryAccess(),
        signal: get().abortController?.signal,
      },
      action.payload
    );

    // For simple operations (restart/update), clear progress on failure
    if (!result.success) {
      const isSimple = action.toolName === 'restart_app' || action.toolName === 'update_app';
      if (isSimple) {
        set({ deployProgress: null });
      }
    }

    const resultContent = JSON.stringify({
      success: result.success,
      data: result.data,
      error: result.error,
    }, bigIntReplacer, 2);

    const toolError = result.success ? undefined : result.error;

    // Update tool message and append assistant message in one atomic update
    const newAssistantMessageId = generateMessageId();
    const newAssistantMessage = {
      id: newAssistantMessageId,
      role: 'assistant' as const,
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    const displayCard = result.success && !result.requiresConfirmation ? result.displayCard : undefined;
    const updatedWithAssistant = get().messages.map((m) =>
      m.id === messageId
        ? { ...m, content: resultContent, card: displayCard, isStreaming: false }
        : m
    );
    set({ messages: [...updatedWithAssistant, newAssistantMessage] });

    const updatedMessages = get().messages.filter((m) => m.id !== newAssistantMessageId);

    const stream = streamChat({
      messages: toChatApiMessages(updatedMessages, get().address),
      signal: get().abortController?.signal,
    });

    const streamResult = await processStreamWithTimeout(
      stream,
      (content, thinking) => {
        get().scheduleStreamingUpdate(newAssistantMessageId, content, thinking);
      }
    );

    get().flushPendingUpdate();

    const updated2 = get().messages.map((m) =>
      m.id === newAssistantMessageId
        ? {
            ...m,
            content: streamResult.error ? `Error: ${streamResult.error}` : streamResult.content,
            thinking: streamResult.thinking || undefined,
            error: streamResult.error || toolError,
            isStreaming: false,
          }
        : m
    );
    set({ messages: updated2 });
  } catch (error) {
    logError('AIContext.confirmAction', error);
    set({ deployProgress: null });
    const errorMessage = error instanceof Error && error.message.includes('timeout')
      ? 'The AI server took too long to respond. The transaction may have completed - please check your wallet.'
      : `Error executing transaction: ${error instanceof Error ? error.message : 'Unknown error'}`;

    const updated = get().messages.map((m) =>
      m.id === messageId
        ? { ...m, content: errorMessage, error: error instanceof Error ? error.message : 'Unknown error', isStreaming: false }
        : m
    );
    set({ messages: updated });
  } finally {
    set({ isStreaming: false, pendingPayload: null });
    get().abortController?.abort();
    set({ abortController: null });
  }
}

export function cancelActionFn(get: Get, set: Set): void {
  const { pendingConfirmation } = get();
  if (!pendingConfirmation) return;

  const { messageId } = pendingConfirmation;
  set({
    pendingConfirmation: null,
    pendingPayload: null,
    deployProgress: null,
  });

  const updated = get().messages.map((m) =>
    m.id === messageId
      ? { ...m, content: 'Action cancelled by user.', isStreaming: false }
      : m
  );
  set({ messages: updated });
}

