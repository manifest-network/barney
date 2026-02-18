/**
 * AIContextType — public interface shape for the AI store.
 * Preserved for backward compatibility with consumers that import this type.
 */

import type { OllamaModel } from '../api/ollama';
import type { AISettings } from '../ai/validation';
import type { SignArbitraryFn, PayloadAttachment } from '../ai/toolExecutor';
import type { DeployProgress } from '../ai/progress';
import type { ChatMessage, PendingConfirmation } from './aiTypes';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';

export interface AIContextType {
  // State
  isOpen: boolean;
  messages: ChatMessage[];
  isStreaming: boolean;
  isConnected: boolean;
  settings: AISettings;
  availableModels: OllamaModel[];
  pendingConfirmation: PendingConfirmation | null;
  pendingPayload: PayloadAttachment | null;
  deployProgress: DeployProgress | null;

  // Actions
  setIsOpen: (open: boolean) => void;
  sendMessage: (content: string) => Promise<void>;
  updateSettings: (settings: Partial<AISettings>) => void;
  clearHistory: () => void;
  refreshModels: (endpoint?: string) => Promise<void>;
  confirmAction: (editedManifestJson?: string) => Promise<void>;
  cancelAction: () => void;
  setClientManager: (manager: CosmosClientManager | null) => void;
  setAddress: (address: string | undefined) => void;
  setSignArbitrary: (fn: SignArbitraryFn | undefined) => void;
  attachPayload: (file: File) => Promise<{ error?: string }>;
  clearPayload: () => void;
  requestBatchDeploy: (apps: Array<{ label: string; manifest: object }>, userMessage?: string) => Promise<void>;
  addLocalMessage: (content: string, card?: { type: string; data: unknown }) => void;
  stopStreaming: () => void;
}
