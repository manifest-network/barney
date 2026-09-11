import type { AIStore } from '../aiStore';
import { executeTool } from '../../ai/toolExecutor';
import { getToolCallDescription } from '../../ai/tools';
import { withTimeout } from '../../api/utils';
import { walletIdentityMatches } from '../../utils/walletIdentity';
import { bigIntReplacer } from '../../utils/json';
import { logError } from '../../utils/errors';
import { generateMessageId, getAppRegistryAccess, trimMessages } from './utils';

type Get = () => AIStore;
type Set = (partial: Partial<AIStore> | ((state: AIStore) => Partial<AIStore>)) => void;

/** A sidebar selection is a fresh query, with no model request or narration.
 * Keep the actual tool call/result in history so later chat can refer to it. */
export async function requestAppStatusFn(get: Get, set: Set, appName: string): Promise<boolean> {
  const state = get();
  const { address, chainId, historyIdentity, authorizationEpoch, clientManager, signing } = state;
  if (!state.isConnected || !address || state.isStreaming || state.pendingConfirmation
    || !walletIdentityMatches(historyIdentity, chainId, address)) return false;

  const registry = getAppRegistryAccess();
  const app = registry.findApp(address, appName);
  if (!app) return false;

  state.abortController?.abort();
  const abort = new AbortController();
  const ownsRequest = () => get().authorizationEpoch === authorizationEpoch && get().abortController === abort;
  const args = { app_name: app.name };
  const toolCallId = generateMessageId();
  const toolMessageId = generateMessageId();
  const toolDescription = getToolCallDescription('app_status', args);
  const timestamp = Date.now();
  set({
    isStreaming: true,
    abortController: abort,
    ...(!state.deployProgress || ['ready', 'failed'].includes(state.deployProgress.phase) ? { deployProgress: null } : {}),
    messages: trimMessages([...state.messages,
      { id: generateMessageId(), role: 'user', content: `What's the status of ${app.name}?`, timestamp },
      {
        id: generateMessageId(), role: 'assistant', content: '', timestamp,
        toolCalls: [{ id: toolCallId, type: 'function', function: { name: 'app_status', arguments: args } }],
      },
      { id: toolMessageId, role: 'tool', content: toolDescription, timestamp, toolName: 'app_status', toolCallId, toolDescription, isStreaming: true },
    ]),
  });

  try {
    const result = await withTimeout(executeTool('app_status', args, {
      address, clientManager, signing, appRegistry: registry, signal: abort.signal, tiers: state.skuTiers.tiers,
    }), undefined, 'Check app status', abort.signal);
    if (!ownsRequest()) return true;
    abort.signal.throwIfAborted();
    const success = result.success && !result.requiresConfirmation;
    const error = success ? undefined : result.error ?? 'Unable to check app status.';
    if (success) get().cacheToolResult(get().getToolCacheKey('app_status', args), result);
    set({ messages: get().messages.map((message) => message.id === toolMessageId ? {
      ...message,
      content: success ? JSON.stringify(result.data, bigIntReplacer, 2) : `Error: ${error}`,
      card: success ? result.displayCard : undefined,
      error,
      isStreaming: false,
    } : message) });
  } catch (error) {
    if (!ownsRequest()) return true;
    const cancelled = abort.signal.aborted;
    if (!cancelled) logError('requestAppStatus', error);
    const content = cancelled ? 'Status check cancelled.' : 'Unable to check app status. Please try again.';
    set({ messages: get().messages.map((message) => message.id === toolMessageId
      ? { ...message, content, error: cancelled ? undefined : content, isStreaming: false }
      : message) });
  } finally {
    if (ownsRequest()) {
      abort.abort();
      set({ isStreaming: false, abortController: null });
    }
  }
  return true;
}
