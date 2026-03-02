/**
 * Tool execution actions — dispatches tool calls, handles caching and display.
 */

import type { ToolCall } from '../../api/morpheus';
import { getToolCallDescription, isValidToolName } from '../../ai/tools';
import { executeTool, type ToolResult } from '../../ai/toolExecutor';
import { buildPayloadFromManifest, type SingleDeployEntry } from '../../ai/toolExecutor/compositeTransactions';
import { sanitizeToolArgs } from '../../ai/validation';
import type { StreamResult } from '../../ai/streamUtils';
import { logError } from '../../utils/errors';
import { validateAppName } from '../../registry/appRegistry';
import type { AIStore } from '../aiStore';
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
): Promise<ToolResult> {
  if (!isValidToolName(toolCall.function.name)) {
    return { success: false, error: `Unknown tool: ${toolCall.function.name}` };
  }

  const sanitizedArgs = sanitizeToolArgs(toolCall.function.arguments);

  const cacheKey = get().getToolCacheKey(toolCall.function.name, sanitizedArgs);
  const cachedResult = get().getCachedToolResult(cacheKey);
  if (cachedResult) return cachedResult;

  // Clear stale deploy progress, but preserve active deploys
  const { deployProgress } = get();
  if (!deployProgress || deployProgress.phase === 'ready' || deployProgress.phase === 'failed') {
    set({ deployProgress: null });
  }

  const { clientManager, address, signArbitrary, abortController, pendingPayload } = get();

  const result = await executeTool(toolCall.function.name, sanitizedArgs, {
    clientManager,
    address,
    signArbitrary,
    onProgress: (progress) => set({ deployProgress: { ...progress } }),
    appRegistry: getAppRegistryAccess(),
    signal: abortController?.signal,
  }, pendingPayload ?? undefined);

  if (result.success && !result.requiresConfirmation) {
    get().cacheToolResult(cacheKey, result);
  }

  return result;
}

/** Collected confirmation from a single tool call. */
interface CollectedConfirmation {
  toolCall: ToolCall;
  toolMessageId: string;
  result: ToolResult & { requiresConfirmation: true };
}

/** Set a single pending confirmation on the store. */
function setSingleConfirmation(
  get: Get,
  set: Set,
  conf: CollectedConfirmation,
): void {
  const toolName = conf.result.pendingAction?.toolName || conf.toolCall.function.name;
  const actionPayload = (toolName === 'deploy_app' || toolName === 'create_lease' || toolName === 'update_app')
    ? get().pendingPayload ?? undefined
    : undefined;

  set({
    pendingConfirmation: {
      id: generateMessageId(),
      action: {
        id: conf.toolCall.id,
        toolName,
        args: conf.result.pendingAction?.args || {},
        description: conf.result.confirmationMessage || 'Confirm action?',
        payload: actionPayload,
      },
      messageId: conf.toolMessageId,
    },
  });

  const updated = get().messages.map((m) =>
    m.id === conf.toolMessageId
      ? { ...m, content: conf.result.confirmationMessage || 'Awaiting confirmation...', isStreaming: false }
      : m
  );
  set({ messages: updated });
}

/**
 * Merge multiple deploy_app confirmations into a single batch_deploy confirmation.
 * Returns true if a confirmation was set, false if all entries failed (caller
 * should let the AI stream continue so it can see the errors).
 */
async function mergeBatchDeployConfirmations(
  get: Get,
  set: Set,
  deployConfs: CollectedConfirmation[],
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
    if (surviving) {
      setSingleConfirmation(get, set, surviving);
      return true;
    }
  }

  // Build batch confirmation description
  const appNames = entries.map((e) => e.app_name).join(', ');
  const description = `Deploy ${entries.length} apps: ${appNames}?`;
  const lastConf = deployConfs[deployConfs.length - 1];

  set({
    pendingConfirmation: {
      id: generateMessageId(),
      action: {
        id: lastConf.toolCall.id,
        toolName: 'batch_deploy',
        args: { entries } as unknown as Record<string, unknown>,
        description,
      },
      messageId: lastConf.toolMessageId,
    },
  });
  return true;
}

export async function processToolCallsFn(
  get: Get,
  set: Set,
  toolCalls: ToolCall[],
  currentAssistantMessageId: string,
  streamResult: StreamResult,
): Promise<ProcessToolCallsResult> {
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

    const result = await handleToolCall(get, set, toolCall);

    if (result.requiresConfirmation) {
      // Collect confirmation — don't return early so remaining tool calls are processed
      collectedConfirmations.push({ toolCall, toolMessageId, result: result as CollectedConfirmation['result'] });
      continue;
    }

    if (result.success && result.displayCard) {
      hasDisplayCard = true;
      const updated = get().messages.map((m) =>
        m.id === toolMessageId
          ? { ...m, content: JSON.stringify(result.data, null, 2), card: result.displayCard, isStreaming: false }
          : m
      );
      set({ messages: updated });
    } else {
      const resultContent = result.success
        ? JSON.stringify(result.data, null, 2)
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
    const deployConfs = collectedConfirmations.filter(
      (c) => (c.result.pendingAction?.toolName || c.toolCall.function.name) === 'deploy_app'
    );

    let confirmed = false;

    if (deployConfs.length >= 2) {
      // Multiple deploy_app → merge into batch_deploy
      confirmed = await mergeBatchDeployConfirmations(get, set, deployConfs);
    }

    if (!confirmed) {
      // Single confirmation, mixed TX types, or all batch entries failed → use first confirmation
      setSingleConfirmation(get, set, collectedConfirmations[0]);
    }

    // Mark any unhandled confirmations as skipped
    const handledIndex = confirmed ? -1 : 0;
    for (let i = 0; i < collectedConfirmations.length; i++) {
      if (i === handledIndex) continue;
      // Skip deploy confs that were handled by batch merge
      if (confirmed && deployConfs.includes(collectedConfirmations[i])) continue;
      const conf = collectedConfirmations[i];
      const updated = get().messages.map((m) =>
        m.id === conf.toolMessageId
          ? { ...m, content: 'Skipped: only one transaction can be confirmed at a time.', isStreaming: false }
          : m
      );
      set({ messages: updated });
    }

    return { shouldContinue: false };
  }

  if (hasDisplayCard) {
    return { shouldContinue: false };
  }

  const newMessage = createAssistantMessage();
  set({ messages: trimMessages([...get().messages, newMessage]) });
  return { shouldContinue: true, nextAssistantMessageId: newMessage.id };
}
