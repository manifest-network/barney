/**
 * Confirmation flow actions — TX confirmation, cancellation, and timeout.
 */

import { streamChat } from '../../api/morpheus';
import { executeConfirmedTool, type ToolResult } from '../../ai/toolExecutor';
import { processStreamWithTimeout } from '../../ai/streamUtils';
import { logError } from '../../utils/errors';
import { bigIntReplacer } from '../../utils/json';
import { isApex, APEX_WARNING } from '../../utils/customDomainValidation';
import { normalizeFqdn } from '../../utils/connection';
import type { AIStore } from '../aiStore';
import {
  AUTHORIZATION_CANCELLED_MESSAGE,
  TRANSACTION_FINISHED_AFTER_CONTEXT_CHANGE_MESSAGE,
  TRANSACTION_INTERRUPTED_MESSAGE,
  assertTransactionAuthorizationCurrent,
  isTransactionAuthorizationCurrent,
} from '../authorization';
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

function serializeToolResult(result: ToolResult, authorizationNotice?: string): string {
  return JSON.stringify({
    success: result.success,
    data: result.data,
    error: result.error,
    ...(authorizationNotice ? { authorizationNotice } : {}),
  }, bigIntReplacer, 2);
}

function resultSummary(result: ToolResult): string | undefined {
  if (!result.success) return result.error;
  if (!result.data || typeof result.data !== 'object') return undefined;
  const message = (result.data as { message?: unknown }).message;
  return typeof message === 'string' && message !== '' ? message : undefined;
}

/** Resolve only the originating tool row after its wallet context has gone
 * stale. Never stream the result into the next wallet's AI turn or attach a
 * wallet-scoped display card. */
function finalizeStaleToolResult(
  set: Set,
  messageId: string,
  result: ToolResult,
): void {
  const summary = resultSummary(result);
  const visibleOutcome = result.success
    ? `${TRANSACTION_FINISHED_AFTER_CONTEXT_CHANGE_MESSAGE}${summary ? ` ${summary}` : ''}`
    : (summary ?? TRANSACTION_INTERRUPTED_MESSAGE);
  set((state) => {
    let resolvedOriginatingRow = false;
    const messages = state.messages.map((message) => {
      if (message.id !== messageId) return message;
      resolvedOriginatingRow = true;
      return {
        ...message,
        content: serializeToolResult(result, visibleOutcome),
        error: result.success ? undefined : visibleOutcome,
        isStreaming: false,
        awaitingConfirmation: false,
        transactionInFlight: false,
      };
    });

    // Successful stale results are not errors, so their collapsed tool row has
    // no inline alert. Surface the wallet-scoped outcome as local assistant copy
    // instead: visible in chat, persisted, and excluded from model history.
    if (result.success && resolvedOriginatingRow) {
      messages.push({
        id: generateMessageId(),
        role: 'assistant',
        content: visibleOutcome,
        timestamp: Date.now(),
        local: true,
      });
    }

    return { messages };
  });
}

function finalizeStaleToolError(set: Set, messageId: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : TRANSACTION_INTERRUPTED_MESSAGE;
  set((state) => ({
    messages: state.messages.map((message) =>
      message.id === messageId
        ? {
            ...message,
            content: detail,
            error: detail,
            isStreaming: false,
            awaitingConfirmation: false,
            transactionInFlight: false,
          }
        : message
    ),
  }));
}

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
    set({ pendingConfirmation: null, pendingPayload: null, deployProgress: null });
    const updated = get().messages.map((m) =>
      m.id === messageId
        ? { ...m, content: 'Wallet disconnected. Please reconnect your wallet and try again.', error: 'wallet_disconnected', isStreaming: false, awaitingConfirmation: false }
        : m
    );
    set({ messages: updated });
    return;
  }

  if (!isTransactionAuthorizationCurrent(get(), pendingConfirmation.action)) {
    const { messageId } = pendingConfirmation;
    set({
      pendingConfirmation: null,
      pendingPayload: null,
      deployProgress: null,
      messages: get().messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              content: AUTHORIZATION_CANCELLED_MESSAGE,
              error: AUTHORIZATION_CANCELLED_MESSAGE,
              isStreaming: false,
              awaitingConfirmation: false,
            }
          : m
      ),
    });
    return;
  }

  const { address, signing } = get();
  const { messageId } = pendingConfirmation;
  const authorization = pendingConfirmation.action;
  const authorizationEpoch = get().authorizationEpoch;

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

  const abort = new AbortController();
  set({
    pendingConfirmation: null,
    activeTransactionMessageId: messageId,
    isStreaming: true,
    abortController: abort,
    messages: get().messages.map((message) =>
      message.id === messageId
        ? {
            ...message,
            isStreaming: false,
            awaitingConfirmation: false,
            transactionInFlight: true,
          }
        : message
    ),
  });

  const assertAuthorization = () => {
    assertTransactionAuthorizationCurrent(get(), authorization);
  };

  const contextIsCurrent = () => get().authorizationEpoch === authorizationEpoch
    && get().abortController === abort
    && isTransactionAuthorizationCurrent(get(), authorization);

  let transactionResolved = false;
  let followUpAssistantMessageId: string | null = null;

  try {
    set({ deployProgress: null });

    // Last synchronous gate before dispatch. `executeConfirmedTool` repeats it,
    // and each concrete executor invokes the same live guard immediately before
    // its non-idempotent SDK/chain call.
    assertAuthorization();
    const result = await executeConfirmedTool(
      action.toolName,
      action.args,
      {
        clientManager,
        address,
        signing,
        onProgress: (progress) => {
          if (get().authorizationEpoch === authorizationEpoch
              && get().abortController === abort) {
            set({ deployProgress: { ...progress } });
          }
        },
        appRegistry: getAppRegistryAccess(),
        signal: abort.signal,
        tiers: get().skuTiers.tiers,
        authorization,
        assertAuthorization,
      },
      action.payload
    );

    if (!contextIsCurrent()) {
      finalizeStaleToolResult(set, messageId, result);
      return;
    }

    // For simple operations (restart/update), clear progress on failure
    if (!result.success) {
      const isSimple = action.toolName === 'restart_app' || action.toolName === 'update_app';
      if (isSimple) {
        set({ deployProgress: null });
      }
    }

    const resultContent = serializeToolResult(result);

    const toolError = result.success ? undefined : result.error;

    const displayCard = result.success && !result.requiresConfirmation ? result.displayCard : undefined;
    const resolvedToolMessages = get().messages.map((m) =>
      m.id === messageId
        ? {
            ...m,
            content: resultContent,
            card: displayCard,
            error: toolError,
            isStreaming: false,
            awaitingConfirmation: false,
            transactionInFlight: false,
          }
        : m
    );
    set({ messages: resolvedToolMessages, activeTransactionMessageId: null });
    transactionResolved = true;

    // A user cancellation stops the transaction orchestration without asking
    // the model for follow-up copy on the already-aborted stream signal. The
    // concrete executor's result remains visible on the tool row and says
    // whether submission was impossible or the on-chain outcome is unknown.
    if (abort.signal.aborted) {
      const summary = resultSummary(result);
      if (result.success && summary) {
        set({
          messages: [
            ...get().messages,
            {
              id: generateMessageId(),
              role: 'assistant',
              content: summary,
              timestamp: Date.now(),
              local: true,
            },
          ],
        });
      }
      return;
    }

    // Append the follow-up assistant message only after the transaction row is
    // resolved and the operation is still live.
    const newAssistantMessageId = generateMessageId();
    followUpAssistantMessageId = newAssistantMessageId;
    const newAssistantMessage = {
      id: newAssistantMessageId,
      role: 'assistant' as const,
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    set({ messages: [...get().messages, newAssistantMessage] });

    const updatedMessages = get().messages.filter((m) => m.id !== newAssistantMessageId);

    const activeAddress = get().address;
    const activeSigning = get().signing;
    const stream = streamChat({
      messages: toChatApiMessages(updatedMessages, get().address, get().skuTiers.tiers),
      signal: abort.signal,
      auth: activeAddress && activeSigning ? {
        walletAddress: activeAddress,
        signChallenge: activeSigning.relayAuth.signChallenge,
      } : undefined,
    });

    const streamResult = await processStreamWithTimeout(
      stream,
      (content, thinking) => {
        if (get().authorizationEpoch === authorizationEpoch
            && get().abortController === abort) {
          get().scheduleStreamingUpdate(newAssistantMessageId, content, thinking);
        }
      }
    );

    if (get().authorizationEpoch !== authorizationEpoch
        || get().abortController !== abort) return;

    get().flushPendingUpdate();

    const updated2 = get().messages.map((m) =>
      m.id === newAssistantMessageId
        ? {
            ...m,
            content: streamResult.error ? `Error: ${streamResult.error}` : streamResult.content,
            thinking: streamResult.thinking || undefined,
            error: streamResult.error,
            isStreaming: false,
          }
        : m
    );
    set({ messages: updated2 });
  } catch (error) {
    // Once the tool row is resolved, subsequent failures belong only to the AI
    // follow-up stream. Never rewrite a completed transaction as failed, and
    // let a wallet-context reset's own closure message stand untouched.
    if (transactionResolved) {
      if (!contextIsCurrent()) return;
      logError('AIContext.confirmAction.followUp', error);
      const detail = error instanceof Error ? error.message : 'Unknown error';
      const content = detail.includes('timeout')
        ? 'The AI server took too long to summarize the transaction result shown above.'
        : 'The transaction result is shown above, but the AI follow-up response failed.';
      set({
        messages: get().messages.map((message) =>
          message.id === followUpAssistantMessageId
            ? { ...message, content, error: detail, isStreaming: false }
            : message
        ),
      });
      return;
    }

    if (!contextIsCurrent()) {
      finalizeStaleToolError(set, messageId, error);
      return;
    }
    logError('AIContext.confirmAction', error);
    set({ deployProgress: null });
    const errorMessage = error instanceof Error && error.message.includes('timeout')
      ? 'The AI server took too long to respond. The transaction may have completed - please check your wallet.'
      : `Error executing transaction: ${error instanceof Error ? error.message : 'Unknown error'}`;

    const updated = get().messages.map((m) =>
      m.id === messageId
        ? {
            ...m,
            content: errorMessage,
            error: error instanceof Error ? error.message : 'Unknown error',
            isStreaming: false,
            awaitingConfirmation: false,
            transactionInFlight: false,
          }
        : m
    );
    set({ messages: updated, activeTransactionMessageId: null });
  } finally {
    if (get().authorizationEpoch === authorizationEpoch
        && get().abortController === abort) {
      set({ isStreaming: false, pendingPayload: null, activeTransactionMessageId: null });
      abort.abort();
      set({ abortController: null });
    }
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
