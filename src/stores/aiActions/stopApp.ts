/**
 * Stop-app action — UI-direct route bypassing the natural-language prompt
 * so app names that happen to collide with `stop_app`'s sentinels (e.g.
 * `"all"`) don't trigger bulk-stop. The model is never involved.
 *
 * Mirrors the synthetic-message + pendingConfirmation flow used by
 * `requestBatchDeployFn`, but skips the pre-confirmation executor
 * (`executeStopApp`) so `resolveMultiAppNames` never fires — that's where
 * the `'all'` sentinel is parsed, even in the UI-direct path. The pending
 * action carries the single-app `{ app_name, leaseUuid }` shape; on
 * confirm, `executeConfirmedStopApp` sees no `entries` and takes its
 * single-app close branch. See PR #93 Copilot 3244138206.
 */

import type { AIStore } from '../aiStore';
import { captureTransactionAuthorization } from '../authorization';
import { generateMessageId, trimMessages, getAppRegistryAccess } from './utils';

type Get = () => AIStore;
type Set = (partial: Partial<AIStore> | ((state: AIStore) => Partial<AIStore>)) => void;

export function requestStopAppFn(get: Get, set: Set, appName: string): void {
  const { isStreaming, isConnected, address, pendingConfirmation } = get();
  // Silent no-op while another confirmation card is open. Without this gate,
  // clicking Stop on app B while a Stop-A / Deploy-X confirmation is already
  // pending overwrites `pendingConfirmation` and orphans the prior tool
  // message (`awaitingConfirmation: true`, no confirm/cancel path — chat
  // wedged). Matches the standard modal-overlay UX: background clicks are
  // inert. See PR #93 Copilot 3248436550.
  if (isStreaming || !isConnected || !address || pendingConfirmation !== null) return;

  const registry = getAppRegistryAccess();
  const authorization = captureTransactionAuthorization(get());
  if (!authorization) return;
  const app = registry.findApp(address, appName);
  if (!app) return;                          // unknown app — silent no-op
  if (app.status === 'stopped') return;      // already stopped — silent no-op

  const syntheticToolCallId = generateMessageId();
  const toolMsgId = generateMessageId();
  const confirmationMessage =
    `Stop app "${app.name}"? This will terminate the deployment and stop billing.`;

  const userMessage = {
    id: generateMessageId(),
    role: 'user' as const,
    content: `Stop ${app.name}`,
    timestamp: Date.now(),
  };
  const assistantMsg = {
    id: generateMessageId(),
    role: 'assistant' as const,
    content: '',
    timestamp: Date.now(),
    toolCalls: [{
      id: syntheticToolCallId,
      type: 'function' as const,
      function: { name: 'stop_app', arguments: { app_name: app.name } },
    }],
  };
  const toolMsg = {
    id: toolMsgId,
    role: 'tool' as const,
    content: confirmationMessage,
    toolName: 'stop_app',
    toolCallId: syntheticToolCallId,
    toolDescription: `Stopping ${app.name}`,
    timestamp: Date.now(),
    isStreaming: false,
    awaitingConfirmation: true,
  };

  set({
    messages: trimMessages([
      ...get().messages,
      userMessage,
      assistantMsg,
      toolMsg,
    ]),
    pendingConfirmation: {
      id: generateMessageId(),
      action: Object.freeze({
        ...authorization,
        id: syntheticToolCallId,
        toolName: 'stop_app',
        args: { app_name: app.name, leaseUuid: app.leaseUuid },
        description: confirmationMessage,
      }),
      messageId: toolMsgId,
    },
  });
}
