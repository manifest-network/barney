/**
 * Batch deploy hook — orchestrates multi-app deploys from the UI.
 * Extracted from AIContext to reduce file size.
 */

import { useCallback } from 'react';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import type { PayloadAttachment } from '../ai/toolExecutor';
import { executeBatchDeploy, deriveAppName } from '../ai/toolExecutor/compositeTransactions';
import type { AppRegistryAccess, SignResult } from '../ai/toolExecutor/types';
import type { DeployProgress } from '../ai/progress';
import { logError } from '../utils/errors';
import { sha256, toHex } from '../utils/hash';
import type { ChatMessage, PendingConfirmation } from '../contexts/aiTypes';
import { generateMessageId } from './useMessageManager';

type SignArbitraryFn = (address: string, data: string) => Promise<SignResult>;

export interface UseBatchDeployDeps {
  isStreamingRef: MutableRefObject<boolean>;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  isConnected: boolean;
  clientManagerRef: MutableRefObject<CosmosClientManager | null>;
  addressRef: MutableRefObject<string | undefined>;
  signArbitraryRef: MutableRefObject<SignArbitraryFn | undefined>;
  addMessage: (message: ChatMessage) => void;
  updateMessageById: (messageId: string, updates: Partial<ChatMessage>) => void;
  setDeployProgress: Dispatch<SetStateAction<DeployProgress | null>>;
  setPendingConfirmation: Dispatch<SetStateAction<PendingConfirmation | null>>;
  getAppRegistryAccess: () => AppRegistryAccess;
}

export function useBatchDeploy(deps: UseBatchDeployDeps) {
  const {
    isStreamingRef, setIsStreaming, isConnected,
    clientManagerRef, addressRef, signArbitraryRef,
    addMessage, updateMessageById,
    setDeployProgress, setPendingConfirmation,
    getAppRegistryAccess,
  } = deps;

  const requestBatchDeploy = useCallback(async (apps: Array<{ label: string; manifest: object }>, originalMessage?: string) => {
    if (isStreamingRef.current || !isConnected) return;
    isStreamingRef.current = true;
    setIsStreaming(true);

    let toolMsgId: string | undefined;
    try {
      const names = apps.map((a) => a.label);
      const userMessage: ChatMessage = {
        id: generateMessageId(),
        role: 'user',
        content: originalMessage || `Deploy ${names.join(', ')}`,
        timestamp: Date.now(),
      };
      addMessage(userMessage);
      setDeployProgress(null);

      // Add synthetic assistant message with tool_calls so the LLM
      // sees a well-formed conversation when summarizing after confirmation.
      const syntheticToolCallId = generateMessageId();
      addMessage({
        id: generateMessageId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [{
          id: syntheticToolCallId,
          type: 'function',
          function: { name: 'batch_deploy', arguments: {} },
        }],
      });

      toolMsgId = generateMessageId();
      addMessage({
        id: toolMsgId,
        role: 'tool',
        content: 'Validating batch deploy...',
        toolName: 'batch_deploy',
        toolCallId: syntheticToolCallId,
        toolDescription: `Deploying ${names.join(', ')}`,
        timestamp: Date.now(),
        isStreaming: true,
      });

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

      const result = await executeBatchDeploy(entries, {
        clientManager: clientManagerRef.current,
        address: addressRef.current,
        signArbitrary: signArbitraryRef.current,
        onProgress: setDeployProgress,
        appRegistry: getAppRegistryAccess(),
      });

      if (result.requiresConfirmation) {
        setPendingConfirmation({
          id: generateMessageId(),
          action: {
            id: 'batch',
            toolName: 'batch_deploy',
            args: result.pendingAction!.args,
            description: result.confirmationMessage!,
          },
          messageId: toolMsgId,
        });
        updateMessageById(toolMsgId, { content: result.confirmationMessage!, isStreaming: false });
      } else {
        updateMessageById(toolMsgId, {
          content: `Error: ${result.error}`,
          error: result.error,
          isStreaming: false,
        });
      }
    } catch (error) {
      logError('AIContext.requestBatchDeploy', error);
      if (toolMsgId) {
        updateMessageById(toolMsgId, {
          content: `Batch deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error: error instanceof Error ? error.message : 'Unknown error',
          isStreaming: false,
        });
      }
    } finally {
      isStreamingRef.current = false;
      setIsStreaming(false);
    }
  }, [isConnected, isStreamingRef, setIsStreaming, clientManagerRef, addressRef, signArbitraryRef, addMessage, updateMessageById, setDeployProgress, setPendingConfirmation, getAppRegistryAccess]);

  return { requestBatchDeploy };
}
