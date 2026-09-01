/**
 * Tool execution actions — dispatches tool calls, handles caching and display.
 */

import type { ToolCall } from '../../api/morpheus';
import { getToolCallDescription, isValidToolName } from '../../ai/tools';
import { executeTool, type ToolResult } from '../../ai/toolExecutor';
import type { TransactionAuthorization } from '../../ai/toolExecutor/types';
import { buildPayloadFromManifest, type SingleDeployEntry } from '../../ai/toolExecutor/compositeTransactions';
import { sanitizeToolArgs } from '../../ai/validation';
import type { StreamResult } from '../../ai/streamUtils';
import { logError } from '../../utils/errors';
import { bigIntReplacer } from '../../utils/json';
import { validateAppName } from '../../registry/appRegistry';
import type { AIStore } from '../aiStore';
import {
  AUTHORIZATION_CANCELLED_MESSAGE,
  captureTransactionAuthorization,
  isTransactionAuthorizationCurrent,
} from '../authorization';
import {
  generateMessageId,
  trimMessages,
  createAssistantMessage,
  getAppRegistryAccess,
} from './utils';

type Get = () => AIStore;
type Set = (partial: Partial<AIStore> | ((state: AIStore) => Partial<AIStore>)) => void;

export type ProcessToolCallsResult =
  | { shouldContinue: false }
  | { shouldContinue: true; nextAssistantMessageId: string };

async function handleToolCall(
  get: Get,
  set: Set,
  toolCall: ToolCall,
  authorizationEpoch: number,
): Promise<{ result: ToolResult; authorization: TransactionAuthorization | null }> {
  if (!isValidToolName(toolCall.function.name)) {
    return {
      result: { success: false, error: `Unknown tool: ${toolCall.function.name}` },
      authorization: null,
    };
  }

  const sanitizedArgs = sanitizeToolArgs(toolCall.function.arguments);

  const cacheKey = get().getToolCacheKey(toolCall.function.name, sanitizedArgs);
  const cachedResult = get().getCachedToolResult(cacheKey);
  if (cachedResult) return { result: cachedResult, authorization: null };

  // Clear stale deploy progress, but preserve active deploys
  const { deployProgress } = get();
  if (!deployProgress || deployProgress.phase === 'ready' || deployProgress.phase === 'failed') {
    set({ deployProgress: null });
  }

  const { clientManager, address, signing, abortController, pendingPayload, skuTiers } = get();
  const authorization = captureTransactionAuthorization(get());

  const result = await executeTool(toolCall.function.name, sanitizedArgs, {
    clientManager,
    address,
    signing,
    onProgress: (progress) => {
      if (get().authorizationEpoch === authorizationEpoch) {
        set({ deployProgress: { ...progress } });
      }
    },
    appRegistry: getAppRegistryAccess(),
    signal: abortController?.signal,
    tiers: skuTiers.tiers,
  }, pendingPayload ?? undefined);

  if (get().authorizationEpoch !== authorizationEpoch) {
    return {
      result: { success: false, error: AUTHORIZATION_CANCELLED_MESSAGE },
      authorization,
    };
  }

  if (result.requiresConfirmation
      && (!authorization || !isTransactionAuthorizationCurrent(get(), authorization))) {
    return {
      result: { success: false, error: AUTHORIZATION_CANCELLED_MESSAGE },
      authorization,
    };
  }

  if (result.success && !result.requiresConfirmation) {
    get().cacheToolResult(cacheKey, result);
  }

  return { result, authorization };
}

/** Collected confirmation from a single tool call. */
interface CollectedConfirmation {
  toolCall: ToolCall;
  toolMessageId: string;
  result: ToolResult & { requiresConfirmation: true };
  authorization: TransactionAuthorization;
}

function markConfirmationsAuthorizationCancelled(
  get: Get,
  set: Set,
  confirmations: readonly CollectedConfirmation[],
): void {
  const messageIds = new Set(confirmations.map((confirmation) => confirmation.toolMessageId));
  set({
    messages: get().messages.map((message) =>
      messageIds.has(message.id)
        ? {
            ...message,
            content: AUTHORIZATION_CANCELLED_MESSAGE,
            error: AUTHORIZATION_CANCELLED_MESSAGE,
            isStreaming: false,
            awaitingConfirmation: false,
          }
        : message
    ),
  });
}

/** Set a single pending confirmation on the store. */
function setSingleConfirmation(
  get: Get,
  set: Set,
  conf: CollectedConfirmation,
): void {
  if (!isTransactionAuthorizationCurrent(get(), conf.authorization)) return;
  const toolName = conf.result.pendingAction?.toolName || conf.toolCall.function.name;
  const actionPayload = (toolName === 'deploy_app' || toolName === 'update_app')
    ? get().pendingPayload ?? undefined
    : undefined;

  set({
    pendingConfirmation: {
      id: generateMessageId(),
      action: Object.freeze({
        ...conf.authorization,
        id: conf.toolCall.id,
        toolName,
        args: conf.result.pendingAction?.args || {},
        description: conf.result.confirmationMessage || 'Confirm action?',
        payload: actionPayload,
      }),
      messageId: conf.toolMessageId,
    },
  });

  const updated = get().messages.map((m) =>
    m.id === conf.toolMessageId
      ? { ...m, content: conf.result.confirmationMessage || 'Awaiting confirmation...', isStreaming: false, awaitingConfirmation: true }
      : m
  );
  set({ messages: updated });
}

/**
 * Merge multiple deploy_app confirmations into a single batch_deploy confirmation.
 * Returns true if at least one entry succeeded and a confirmation was set.
 * Returns false if all entries failed — caller must avoid setting a single
 * confirmation for a broken deploy and should instead let the AI stream
 * continue so it can see the per-entry error messages.
 */
async function mergeBatchDeployConfirmations(
  get: Get,
  set: Set,
  deployConfs: CollectedConfirmation[],
  authorizationEpoch: number,
): Promise<boolean> {
  const entries: SingleDeployEntry[] = [];
  const address = get().address;
  const usedNames = new Set<string>();
  let pendingPayloadUsed = false;

  for (const conf of deployConfs) {
    const args = conf.result.pendingAction?.args || {};
    try {
      // Build payload from stored manifest (image/stack-based deploy path)
      let payload = typeof args._generatedManifest === 'string'
        ? await buildPayloadFromManifest(args._generatedManifest)
        : undefined;

      if (get().authorizationEpoch !== authorizationEpoch
          || !isTransactionAuthorizationCurrent(get(), conf.authorization)) {
        markConfirmationsAuthorizationCancelled(get, set, deployConfs);
        return false;
      }

      // Fall back to pending payload from store (file-upload path) — only once
      if (!payload && !pendingPayloadUsed) {
        payload = get().pendingPayload ?? undefined;
        if (payload) pendingPayloadUsed = true;
      }
      if (!payload) {
        throw new Error('Payload missing');
      }

      // Deduplicate app names within the batch
      let name = typeof args.app_name === 'string' ? args.app_name : '';
      if (!name) {
        throw new Error('App name missing');
      }
      if (address && (usedNames.has(name) || validateAppName(name, address) !== null)) {
        const baseName = name;
        let suffix = 2;
        let resolved = false;
        while (suffix <= 99) {
          const candidate = `${baseName}-${suffix}`.slice(0, 32);
          if (!usedNames.has(candidate) && (!address || validateAppName(candidate, address) === null)) {
            name = candidate;
            resolved = true;
            break;
          }
          suffix++;
        }
        if (!resolved) {
          throw new Error(`Cannot find unique name for "${baseName}"`);
        }
      }
      usedNames.add(name);

      entries.push({
        app_name: name,
        size: typeof args.size === 'string' ? args.size : 'micro',
        skuUuid: args.skuUuid as string,
        providerUuid: args.providerUuid as string,
        providerUrl: args.providerUrl as string,
        payload,
        serviceNames: args._serviceNames as string[] | undefined,
        // Thread per-entry custom domain through into the batch. Without this
        // the batch path used to silently drop the attach — both deploys
        // succeeded but no MsgSetItemCustomDomain ever broadcast, leaving the
        // user to discover the missing domain when DNS didn't resolve.
        ...(typeof args.customDomain === 'string' && args.customDomain ? {
          customDomain: args.customDomain,
          customDomainServiceName: typeof args.customDomainServiceName === 'string'
            ? args.customDomainServiceName : '',
          ...(typeof args.customDomainWarning === 'string' && args.customDomainWarning
            ? { customDomainWarning: args.customDomainWarning } : {}),
        } : {}),
      });

      // Mark this tool message as awaiting batch confirmation
      const updated = get().messages.map((m) =>
        m.id === conf.toolMessageId
          ? { ...m, content: `Batch deploy: ${name}`, isStreaming: false }
          : m
      );
      set({ messages: updated });
    } catch (error) {
      // Mark this entry's tool message as failed, exclude from batch
      logError('mergeBatchDeployConfirmations', error);
      const errorMsg = error instanceof Error ? error.message : 'Failed to build payload';
      const updated = get().messages.map((m) =>
        m.id === conf.toolMessageId
          ? { ...m, content: `Error: ${errorMsg}`, error: errorMsg, isStreaming: false }
          : m
      );
      set({ messages: updated });
    }
  }

  if (entries.length === 0) {
    // All entries failed — caller should let the AI stream continue
    return false;
  }

  // If only one survived, treat as single deploy
  if (entries.length === 1) {
    // Find the original confirmation that produced this surviving entry
    const surviving = deployConfs.find(
      (c) => {
        const argName = typeof c.result.pendingAction?.args?.app_name === 'string'
          ? c.result.pendingAction.args.app_name
          : undefined;
        // Match by original name or deduped name
        return argName === entries[0].app_name || (argName && entries[0].app_name.startsWith(argName));
      }
    );
    // Fallback to first deploy conf if dedup renamed beyond recognition
    setSingleConfirmation(get, set, surviving ?? deployConfs[0]);
    return true;
  }

  // Build batch confirmation description
  const appNames = entries.map((e) => e.app_name).join(', ');
  const description = `Deploy ${entries.length} apps: ${appNames}?`;
  const lastConf = deployConfs[deployConfs.length - 1];

  if (get().authorizationEpoch !== authorizationEpoch
      || !isTransactionAuthorizationCurrent(get(), lastConf.authorization)) {
    markConfirmationsAuthorizationCancelled(get, set, deployConfs);
    return false;
  }

  set({
    pendingConfirmation: {
      id: generateMessageId(),
      action: Object.freeze({
        ...lastConf.authorization,
        id: lastConf.toolCall.id,
        toolName: 'batch_deploy',
        args: { entries } as unknown as Record<string, unknown>,
        description,
      }),
      messageId: lastConf.toolMessageId,
    },
  });
  // Mark the owning message as awaiting batch confirmation — same invariant
  // `setSingleConfirmation` already maintains at the top of this file. Only
  // the owning tool message (last batch entry — its messageId is what we
  // stored in pendingConfirmation.messageId) gets the flag. The other batch
  // entries are status placeholders ("Batch deploy: <name>"), not awaiting
  // any confirmation themselves; flagging them would make rehydrate write
  // Interrupted markers on N-1 messages that never had a pending confirm.
  //
  // Schema preserves the flag through Zod since 87b22b2; rehydrate at
  // persistence.ts:82-89 reads it on reload to emit the closure marker.
  const owningId = lastConf.toolMessageId;
  const withFlag = get().messages.map((m) =>
    m.id === owningId ? { ...m, awaitingConfirmation: true } : m
  );
  set({ messages: withFlag });
  return true;
}

/**
 * Resolve a batch of collected confirmations into a single pending TX.
 *
 * One AI streaming turn can produce multiple tool calls that each return a
 * confirmation. We can only show the user one ConfirmationCard at a time —
 * this function decides which one wins, builds a batch_deploy when there are
 * 2+ deploys, and marks the rest of the messages clearly so the chat reads
 * cleanly.
 *
 * Disposition (in priority order):
 *   1. 2+ deploy_app and at least one buildable payload → merge into a single
 *      `batch_deploy` confirmation; non-deploy confirmations marked "skipped".
 *   2. 2+ deploy_app where every payload build failed AND no other TX types →
 *      no confirmation set; the per-entry error messages already in chat tell
 *      the AI what went wrong, so let the stream continue.
 *   3. Otherwise → set the first non-deploy confirmation (or first deploy when
 *      no batch merge applies); other confirmations marked "skipped".
 */
async function coalesceConfirmations(
  get: Get,
  set: Set,
  collected: CollectedConfirmation[],
  authorizationEpoch: number,
): Promise<ProcessToolCallsResult> {
  const deployConfs = collected.filter(
    (c) => (c.result.pendingAction?.toolName || c.toolCall.function.name) === 'deploy_app',
  );
  const nonDeployConfs = collected.filter((c) => !deployConfs.includes(c));

  // Path 1: 2+ deploy_app — try to merge into a batch.
  if (deployConfs.length >= 2) {
    const merged = await mergeBatchDeployConfirmations(get, set, deployConfs, authorizationEpoch);
    if (get().authorizationEpoch !== authorizationEpoch) {
      return { shouldContinue: false };
    }
    if (merged) {
      // Batch merge succeeded — mark non-deploy confirmations as skipped.
      markSkipped(get, set, nonDeployConfs);
      return { shouldContinue: false };
    }

    // Path 2: every payload build failed AND nothing else to confirm — let
    // the AI see the per-entry errors (already written to messages by
    // mergeBatchDeployConfirmations) so it can react.
    if (nonDeployConfs.length === 0) {
      const newMessage = createAssistantMessage();
      set({ messages: trimMessages([...get().messages, newMessage]) });
      return { shouldContinue: true, nextAssistantMessageId: newMessage.id };
    }

    // Batch merge failed but there's another TX type — fall through to
    // single confirmation on the non-deploy. Failed deploy confs keep their
    // error messages, so they're not in `markSkipped`'s set.
    setSingleConfirmation(get, set, nonDeployConfs[0]);
    markSkipped(get, set, nonDeployConfs.slice(1));
    return { shouldContinue: false };
  }

  // Path 3: 0 or 1 deploys (no batch merge needed). First confirmation wins.
  const winner = collected[0];
  setSingleConfirmation(get, set, winner);
  markSkipped(get, set, collected.slice(1));
  return { shouldContinue: false };
}

/** Mark each tool message as skipped — the user can only confirm one TX. */
function markSkipped(get: Get, set: Set, confs: CollectedConfirmation[]): void {
  if (confs.length === 0) return;
  const skippedIds = new Set(confs.map((c) => c.toolMessageId));
  const updated = get().messages.map((m) =>
    skippedIds.has(m.id)
      ? { ...m, content: 'Skipped: only one transaction can be confirmed at a time.', isStreaming: false }
      : m,
  );
  set({ messages: updated });
}

export async function processToolCallsFn(
  get: Get,
  set: Set,
  toolCalls: ToolCall[],
  currentAssistantMessageId: string,
  streamResult: StreamResult,
  authorizationEpoch = get().authorizationEpoch,
): Promise<ProcessToolCallsResult> {
  if (get().authorizationEpoch !== authorizationEpoch) return { shouldContinue: false };
  // Update the assistant message with the stream result
  const updated1 = get().messages.map((m) =>
    m.id === currentAssistantMessageId
      ? { ...m, content: streamResult.content, thinking: streamResult.thinking || undefined, toolCalls, isStreaming: false }
      : m
  );
  set({ messages: updated1 });

  let hasDisplayCard = false;
  const collectedConfirmations: CollectedConfirmation[] = [];

  for (const toolCall of toolCalls) {
    if (get().authorizationEpoch !== authorizationEpoch) return { shouldContinue: false };
    const toolDescription = getToolCallDescription(toolCall.function.name, toolCall.function.arguments);
    const toolMessageId = generateMessageId();

    // Add tool message
    const toolMsg = {
      id: toolMessageId,
      role: 'tool' as const,
      content: toolDescription,
      toolDescription,
      timestamp: Date.now(),
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      isStreaming: true,
    };
    set({ messages: trimMessages([...get().messages, toolMsg]) });

    const handled = await handleToolCall(get, set, toolCall, authorizationEpoch);
    if (get().authorizationEpoch !== authorizationEpoch) return { shouldContinue: false };
    const { result, authorization } = handled;

    if (result.requiresConfirmation) {
      if (!authorization) return { shouldContinue: false };
      // Collect confirmation — don't return early so remaining tool calls are processed
      collectedConfirmations.push({
        toolCall,
        toolMessageId,
        result: result as CollectedConfirmation['result'],
        authorization,
      });
      continue;
    }

    if (result.success && result.displayCard) {
      hasDisplayCard = true;
      const updated = get().messages.map((m) =>
        m.id === toolMessageId
          ? { ...m, content: JSON.stringify(result.data, bigIntReplacer, 2), card: result.displayCard, isStreaming: false }
          : m
      );
      set({ messages: updated });
    } else {
      const resultContent = result.success
        ? JSON.stringify(result.data, bigIntReplacer, 2)
        : `Error: ${result.error}`;

      const updated = get().messages.map((m) =>
        m.id === toolMessageId
          ? { ...m, content: resultContent, error: result.success ? undefined : result.error, isStreaming: false }
          : m
      );
      set({ messages: updated });
    }
  }

  // Handle collected confirmations
  if (collectedConfirmations.length > 0) {
    return await coalesceConfirmations(get, set, collectedConfirmations, authorizationEpoch);
  }

  if (hasDisplayCard) {
    return { shouldContinue: false };
  }

  const newMessage = createAssistantMessage();
  set({ messages: trimMessages([...get().messages, newMessage]) });
  return { shouldContinue: true, nextAssistantMessageId: newMessage.id };
}
