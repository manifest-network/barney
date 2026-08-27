/**
 * Confirmation flow actions — TX confirmation, cancellation, and timeout.
 */

import { streamChat } from '../../api/morpheus';
import { executeConfirmedTool } from '../../ai/toolExecutor';
import { processStreamWithTimeout } from '../../ai/streamUtils';
import { logError } from '../../utils/errors';
import { bigIntReplacer } from '../../utils/json';
import { isApex, APEX_WARNING } from '../../utils/customDomainValidation';
import { normalizeFqdn } from '../../utils/connection';
import type { AIStore } from '../aiStore';
import { generateMessageId, toChatApiMessages, getAppRegistryAccess } from './utils';

const DEPLOY_DOMAIN_KEYS = ['customDomain', 'customDomainServiceName', 'customDomainWarning'] as const;

/**
 * Apply the user's custom-domain override to the deploy_app pendingAction args.
 *  - empty `domain` removes all domain-related keys (deploy proceeds without attach)
 *  - non-empty `domain` writes/overwrites the keys; the apex warning is recomputed
 *    synchronously via `isApex` so post-broadcast success copy stays in sync.
 */
function mergeCustomDomainOverride(
  args: Record<string, unknown>,
  domain: string,
  serviceName: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...args };
  for (const k of DEPLOY_DOMAIN_KEYS) delete next[k];
  if (domain !== '') {
    next.customDomain = domain;
    next.customDomainServiceName = serviceName;
    if (isApex(domain)) next.customDomainWarning = APEX_WARNING;
  }
  return next;
}

type Get = () => AIStore;
type Set = (partial: Partial<AIStore> | ((state: AIStore) => Partial<AIStore>)) => void;

/** User-confirmable overrides applied at confirm-time before broadcast.
 *  Single source of truth — `ConfirmationCard.handleConfirm` and `aiStore.confirmAction`
 *  both go through this shape. Add new override fields here.
 *
 *  Convention: `undefined` = leave the pendingAction.args value as-is; empty
 *  string = explicit clear; non-empty = set/replace.
 */
export interface ConfirmActionOverrides {
  /** Replaces `_generatedManifest` for deploy_app/update_app's manifest editor flow. */
  editedManifestJson?: string;
  /** deploy_app only: user-entered (or AI-prefilled) custom domain. */
  editedCustomDomain?: string;
  /** deploy_app only: service to attach the domain to (multi-service stacks). */
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
        ? { ...m, content: 'Wallet disconnected. Please reconnect your wallet and try again.', error: 'wallet_disconnected', isStreaming: false, awaitingConfirmation: false }
        : m
    );
    set({ messages: updated });
    return;
  }

  const { address, signing } = get();
  const { messageId } = pendingConfirmation;

  // Clone action to avoid mutating React state; apply user edits if present.
  let confirmedArgs = pendingConfirmation.action.args;
  let confirmedPayload = pendingConfirmation.action.payload;
  if (overrides?.editedManifestJson && confirmedArgs._generatedManifest) {
    confirmedArgs = { ...confirmedArgs, _generatedManifest: overrides.editedManifestJson };
    confirmedPayload = undefined;
  }
  // For deploy_app, allow the user to add/edit/clear the custom_domain at confirm
  // time. The pending args carry whatever the AI prefilled; the override is what's
  // in the input field at the moment of confirmation. Empty string = no attach.
  // The async chain-Params reserved-suffix check doesn't re-run here; the chain
  // rejects authoritatively if the domain falls in a reserved zone.
  if (overrides && pendingConfirmation.action.toolName === 'deploy_app' &&
      overrides.editedCustomDomain !== undefined) {
    confirmedArgs = mergeCustomDomainOverride(
      confirmedArgs,
      normalizeFqdn(overrides.editedCustomDomain),
      overrides.editedCustomDomainServiceName ?? '',
    );
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
        signing,
        onProgress: (progress) => set({ deployProgress: { ...progress } }),
        appRegistry: getAppRegistryAccess(),
        signal: get().abortController?.signal,
        tiers: get().skuTiers.tiers,
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
        ? { ...m, content: resultContent, card: displayCard, isStreaming: false, awaitingConfirmation: false }
        : m
    );
    set({ messages: [...updatedWithAssistant, newAssistantMessage] });

    const updatedMessages = get().messages.filter((m) => m.id !== newAssistantMessageId);

    const activeAddress = get().address;
    const activeSigning = get().signing;
    const stream = streamChat({
      messages: toChatApiMessages(updatedMessages, get().address, get().skuTiers.tiers),
      signal: get().abortController?.signal,
      auth: activeAddress && activeSigning ? {
        walletAddress: activeAddress,
        signChallenge: activeSigning.relayAuth.signChallenge,
      } : undefined,
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
        ? { ...m, content: errorMessage, error: error instanceof Error ? error.message : 'Unknown error', isStreaming: false, awaitingConfirmation: false }
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
      ? { ...m, content: 'Action cancelled by user.', isStreaming: false, awaitingConfirmation: false }
      : m
  );
  set({ messages: updated });
}
