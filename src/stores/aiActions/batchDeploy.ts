/**
 * Batch deploy action — orchestrates multi-app deploys from the UI.
 */

import type { PayloadAttachment } from '../../ai/toolExecutor';
import { executeBatchDeploy, deriveAppName } from '../../ai/toolExecutor/compositeTransactions';
import { logError } from '../../utils/errors';
import { sha256, toHex } from '../../utils/hash';
import type { AIStore } from '../aiStore';
import { generateMessageId, trimMessages, getAppRegistryAccess } from './utils';

type Get = () => AIStore;
type Set = (partial: Partial<AIStore> | ((state: AIStore) => Partial<AIStore>)) => void;

export async function requestBatchDeployFn(
  get: Get,
  set: Set,
  apps: Array<{ label: string; manifest: object }>,
  originalMessage?: string,
): Promise<void> {
  const { isStreaming, isConnected } = get();
  if (isStreaming || !isConnected) return;

  set({ isStreaming: true });

  let toolMsgId: string | undefined;
  try {
    const names = apps.map((a) => a.label);
    const userMessage = {
      id: generateMessageId(),
      role: 'user' as const,
      content: originalMessage || `Deploy ${names.join(', ')}`,
      timestamp: Date.now(),
    };
    set({ messages: trimMessages([...get().messages, userMessage]), deployProgress: null });

    // Add synthetic assistant message with tool_calls
    const syntheticToolCallId = generateMessageId();
    const assistantMsg = {
      id: generateMessageId(),
      role: 'assistant' as const,
      content: '',
      timestamp: Date.now(),
      toolCalls: [{
        id: syntheticToolCallId,
        type: 'function' as const,
        function: { name: 'batch_deploy', arguments: {} },
      }],
    };
    set({ messages: trimMessages([...get().messages, assistantMsg]) });

    toolMsgId = generateMessageId();
    const toolMsg = {
      id: toolMsgId,
      role: 'tool' as const,
      content: 'Validating batch deploy...',
      toolName: 'batch_deploy',
      toolCallId: syntheticToolCallId,
      toolDescription: `Deploying ${names.join(', ')}`,
      timestamp: Date.now(),
      isStreaming: true,
    };
    set({ messages: trimMessages([...get().messages, toolMsg]) });

    // Create payloads for each app
    const entries = await Promise.all(apps.map(async (app) => {
      const filename = `manifest-${app.label.toLowerCase().replace(/[^a-z0-9]/g, '-')}.json`;
      const blob = new Blob([JSON.stringify(app.manifest, null, 2)], { type: 'application/json' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const hashBytes = await sha256(bytes);
      const hash = toHex(hashBytes);
      return {
        app_name: deriveAppName(filename),
        payload: { bytes, filename, size: blob.size, hash } as PayloadAttachment,
      };
    }));

    const { clientManager, address, signArbitrary } = get();

    const result = await executeBatchDeploy(entries, {
      clientManager,
      address,
      signArbitrary,
      onProgress: (progress) => set({ deployProgress: { ...progress } }),
      appRegistry: getAppRegistryAccess(),
    });

    if (result.requiresConfirmation) {
      set({
        pendingConfirmation: {
          id: generateMessageId(),
          action: {
            id: 'batch',
            toolName: 'batch_deploy',
            args: result.pendingAction!.args,
            description: result.confirmationMessage!,
          },
          messageId: toolMsgId,
        },
      });
      const updated = get().messages.map((m) =>
        m.id === toolMsgId
          ? { ...m, content: result.confirmationMessage!, isStreaming: false }
          : m
      );
      set({ messages: updated });
    } else {
      const updated = get().messages.map((m) =>
        m.id === toolMsgId
          ? { ...m, content: `Error: ${result.error}`, error: result.error, isStreaming: false }
          : m
      );
      set({ messages: updated });
    }
  } catch (error) {
    logError('AIContext.requestBatchDeploy', error);
    if (toolMsgId) {
      const updated = get().messages.map((m) =>
        m.id === toolMsgId
          ? {
              ...m,
              content: `Batch deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
              error: error instanceof Error ? error.message : 'Unknown error',
              isStreaming: false,
            }
          : m
      );
      set({ messages: updated });
    }
  } finally {
    set({ isStreaming: false });
  }
}
