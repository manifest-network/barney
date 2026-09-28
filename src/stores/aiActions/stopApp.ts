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
import { transactionConfirmation } from '../../ai/toolExecutor/transactionPlans';
import { pendingMaintenanceStopWarning } from '../../ai/toolExecutor/maintenanceStopWarning';
import { generateMessageId, trimMessages, getAppRegistryAccess } from './utils';

type Get = () => AIStore;
type Set = (partial: Partial<AIStore> | ((state: AIStore) => Partial<AIStore>)) => void;

export function requestStopAppFn(get: Get, set: Set, appName: string): void {
  const { isStreaming, address, pendingConfirmation } = get();
  // Keep the existing request/confirmation intact, and explain an intentional
  // click without disabling every historical card throughout a chat reply.
  if (isStreaming || pendingConfirmation !== null) {
    get().addLocalMessage(pendingConfirmation
      ? 'Confirm or cancel the pending action before stopping an app.'
      : 'Finish or cancel the current request before stopping an app.');
    return;
  }

  const registry = getAppRegistryAccess();
  const authorization = captureTransactionAuthorization(get());
  if (!authorization || !address) {
    get().addLocalMessage('Your wallet is not ready to stop an app. Wait for it to connect, then try again.');
    return;
  }
  const app = registry.findApp(address, appName);
  if (!app) {
    get().addLocalMessage(`App "${appName}" is no longer in this wallet's app list.`);
    return;
  }
  if (app.status === 'stopped' || app.chainState === 'absent') {
    get().addLocalMessage(`App "${app.name}" has no active lease to stop. No transaction is needed.`);
    return;
  }

  const syntheticToolCallId = generateMessageId();
  const toolMsgId = generateMessageId();
  const confirmationMessage =
    `Stop app "${app.name}"? This will terminate the deployment and stop billing.`
    + pendingMaintenanceStopWarning([app], address, authorization.chainId);
  const plan = transactionConfirmation('stop_app', {
    app_name: app.name, leaseUuid: app.leaseUuid,
  }, confirmationMessage);
  if (!plan.requiresConfirmation) return;

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
        args: plan.pendingAction.args,
        description: confirmationMessage,
      }),
      messageId: toolMsgId,
    },
  });
}
