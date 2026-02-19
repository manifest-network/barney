/**
 * Zustand store for AI chat state.
 * Replaces AIContext + useRef mirrors + extracted hooks.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import type { OllamaModel } from '../api/ollama';
import { checkOllamaHealth, listModels } from '../api/ollama';
import type { AISettings } from '../ai/validation';
import type { SignArbitraryFn, PayloadAttachment, ToolResult } from '../ai/toolExecutor';
import type { DeployProgress } from '../ai/progress';
import { validateEndpointUrl } from '../ai/validation';
import { validateFile, validateManifestContent } from '../utils/fileValidation';
import { sha256, toHex } from '../utils/hash';
import { logError } from '../utils/errors';
import {
  AI_TOOL_CACHE_TTL_MS,
  AI_TOOL_CACHE_MAX_SIZE,
} from '../config/constants';
import type { ChatMessage, PendingConfirmation } from '../contexts/aiTypes';

import { loadSettings, loadHistory, clearHistoryStorage } from './aiActions/persistence';
import { scheduleStreamingUpdateFn, flushPendingUpdateFn } from './aiActions/streaming';
import { sendMessageFn } from './aiActions/sendMessage';
import { confirmActionFn, cancelActionFn } from './aiActions/confirmAction';
import { requestBatchDeployFn } from './aiActions/batchDeploy';
import { generateMessageId, trimMessages } from './aiActions/utils';

// Re-export for use by action modules and consumers
export { generateMessageId };

// Re-export types for backward compatibility
export type { ChatMessage, PendingConfirmation } from '../contexts/aiTypes';
export type { AISettings } from '../ai/validation';

export interface AIStore {
  // --- Reactive state (components select these) ---
  isOpen: boolean;
  messages: ChatMessage[];
  isStreaming: boolean;
  isConnected: boolean;
  settings: AISettings;
  availableModels: OllamaModel[];
  pendingConfirmation: PendingConfirmation | null;
  pendingPayload: PayloadAttachment | null;
  deployProgress: DeployProgress | null;

  // --- Internal state (only accessed via get() in actions) ---
  clientManager: CosmosClientManager | null;
  address: string | undefined;
  signArbitrary: SignArbitraryFn | undefined;
  abortController: AbortController | null;
  lastMessageTime: number;
  _toolCache: Map<string, { result: ToolResult; timestamp: number }>;
  _pendingStreamUpdate: { messageId: string; content: string; thinking?: string } | null;
  _rafId: number | null;

  // --- Actions ---
  setIsOpen: (open: boolean) => void;
  sendMessage: (content: string) => Promise<void>;
  confirmAction: (editedManifestJson?: string) => Promise<void>;
  cancelAction: () => void;
  addMessage: (message: ChatMessage) => void;
  updateMessageById: (messageId: string, updates: Partial<ChatMessage>) => void;
  getCurrentMessages: (excludeId?: string) => ChatMessage[];
  attachPayload: (file: File) => Promise<{ error?: string }>;
  clearPayload: () => void;
  setClientManager: (manager: CosmosClientManager | null) => void;
  setAddress: (address: string | undefined) => void;
  setSignArbitrary: (fn: SignArbitraryFn | undefined) => void;
  updateSettings: (settings: Partial<AISettings>) => void;
  clearHistory: () => void;
  refreshModels: (endpoint?: string) => Promise<void>;
  requestBatchDeploy: (apps: Array<{ label: string; manifest: object }>, userMessage?: string) => Promise<void>;
  addLocalMessage: (content: string, card?: { type: string; data: unknown }) => void;
  stopStreaming: () => void;
  scheduleStreamingUpdate: (messageId: string, content: string, thinking?: string) => void;
  flushPendingUpdate: () => void;

  // --- Tool cache ---
  getToolCacheKey: (toolName: string, args: Record<string, unknown>) => string;
  getCachedToolResult: (cacheKey: string) => ToolResult | null;
  cacheToolResult: (cacheKey: string, result: ToolResult) => void;
  clearToolCache: () => void;

  // --- Lifecycle ---
  destroy: () => void;
}

export const createAIStore = () =>
  createStore<AIStore>((set, get) => ({
    // --- Initial state ---
    isOpen: false,
    messages: loadHistory(),
    isStreaming: false,
    isConnected: false,
    settings: loadSettings(),
    availableModels: [],
    pendingConfirmation: null,
    pendingPayload: null,
    deployProgress: null,

    clientManager: null,
    address: undefined,
    signArbitrary: undefined,
    abortController: null,
    lastMessageTime: 0,
    _toolCache: new Map(),
    _pendingStreamUpdate: null,
    _rafId: null,

    // --- Simple actions ---
    setIsOpen: (open) => set({ isOpen: open }),

    addMessage: (message) => {
      set({ messages: trimMessages([...get().messages, message]) });
    },

    updateMessageById: (messageId, updates) => {
      const updated = get().messages.map((m) =>
        m.id === messageId ? { ...m, ...updates } : m
      );
      set({ messages: updated });
    },

    getCurrentMessages: (excludeId) => {
      const current = get().messages;
      return excludeId ? current.filter((m) => m.id !== excludeId) : current;
    },

    addLocalMessage: (content, card) => {
      const msg: ChatMessage = {
        id: generateMessageId(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
        card,
      };
      set({ messages: trimMessages([...get().messages, msg]) });
    },

    stopStreaming: () => {
      get().abortController?.abort();
    },

    // --- Wallet setters ---
    setClientManager: (manager) => {
      set({ clientManager: manager });
    },

    setAddress: (address) => {
      if (address !== get().address) {
        get()._toolCache.clear();
        set({ deployProgress: null });
      }
      set({ address });
    },

    setSignArbitrary: (fn) => {
      set({ signArbitrary: fn });
    },

    // --- Payload attachment ---
    attachPayload: async (file) => {
      const validation = validateFile(file);
      if (!validation.valid) {
        return { error: validation.error };
      }

      try {
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        const contentValidation = validateManifestContent(bytes, file.name);
        if (!contentValidation.valid) {
          return { error: contentValidation.error };
        }

        const hashBytes = await sha256(bytes);
        const hash = toHex(hashBytes);

        const attachment: PayloadAttachment = {
          bytes,
          filename: file.name,
          size: file.size,
          hash,
        };

        set({ pendingPayload: attachment });
        return {};
      } catch (error) {
        logError('AIContext.attachPayload', error);
        return { error: 'Failed to read file' };
      }
    },

    clearPayload: () => {
      set({ pendingPayload: null });
    },

    // --- Settings ---
    updateSettings: (newSettings) => {
      set((state) => {
        const updated = { ...state.settings };

        if (newSettings.ollamaEndpoint !== undefined) {
          const validatedUrl = validateEndpointUrl(newSettings.ollamaEndpoint);
          if (validatedUrl) {
            updated.ollamaEndpoint = validatedUrl;
          }
        }

        if (typeof newSettings.model === 'string' && newSettings.model.length > 0) {
          updated.model = newSettings.model;
        }
        if (typeof newSettings.saveHistory === 'boolean') {
          updated.saveHistory = newSettings.saveHistory;
        }
        if (typeof newSettings.enableThinking === 'boolean') {
          updated.enableThinking = newSettings.enableThinking;
        }

        return { settings: updated };
      });
    },

    // --- History ---
    clearHistory: () => {
      get()._toolCache.clear();
      clearHistoryStorage();
      set({ messages: [] });
    },

    // --- Models ---
    refreshModels: async (endpoint) => {
      try {
        const models = await listModels(endpoint || get().settings.ollamaEndpoint);
        set({ availableModels: models });
      } catch (error) {
        logError('aiStore.refreshModels', error);
      }
    },

    // --- Streaming ---
    scheduleStreamingUpdate: (messageId, content, thinking) => {
      scheduleStreamingUpdateFn(get, set, messageId, content, thinking);
    },

    flushPendingUpdate: () => {
      flushPendingUpdateFn(get, set);
    },

    // --- Complex actions ---
    sendMessage: (content) => sendMessageFn(get, set, content),
    confirmAction: (editedManifestJson) => confirmActionFn(get, set, editedManifestJson),
    cancelAction: () => cancelActionFn(get, set),
    requestBatchDeploy: (apps, userMessage) => requestBatchDeployFn(get, set, apps, userMessage),

    // --- Tool cache ---
    getToolCacheKey: (toolName, args) => {
      const addr = get().address ?? '';
      const sortedArgs = Object.keys(args).sort().reduce((acc, key) => {
        acc[key] = args[key];
        return acc;
      }, {} as Record<string, unknown>);
      return `${addr}:${toolName}:${JSON.stringify(sortedArgs)}`;
    },

    getCachedToolResult: (cacheKey) => {
      const cached = get()._toolCache.get(cacheKey);
      if (!cached) return null;
      if (Date.now() - cached.timestamp > AI_TOOL_CACHE_TTL_MS) {
        get()._toolCache.delete(cacheKey);
        return null;
      }
      return cached.result;
    },

    cacheToolResult: (cacheKey, result) => {
      const cache = get()._toolCache;
      if (cache.size >= AI_TOOL_CACHE_MAX_SIZE) {
        const entries = Array.from(cache.entries());
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = Math.max(1, Math.floor(AI_TOOL_CACHE_MAX_SIZE * 0.1));
        for (let i = 0; i < toRemove; i++) {
          cache.delete(entries[i][0]);
        }
      }
      cache.set(cacheKey, { result, timestamp: Date.now() });
    },

    clearToolCache: () => {
      get()._toolCache.clear();
    },

    // --- Lifecycle ---
    destroy: () => {
      const { _rafId, abortController } = get();
      if (_rafId) cancelAnimationFrame(_rafId);
      if (abortController) abortController.abort();
      set({ _rafId: null, abortController: null });
      _store = null;
    },
  }));

// Singleton store instance
let _store: ReturnType<typeof createAIStore> | null = null;

export function getAIStore(): ReturnType<typeof createAIStore> {
  if (!_store) {
    _store = createAIStore();
  }
  return _store;
}

/** Check Ollama connection health and update store */
export async function checkConnection(store: ReturnType<typeof createAIStore>): Promise<void> {
  try {
    const healthy = await checkOllamaHealth(store.getState().settings.ollamaEndpoint);
    store.setState({ isConnected: healthy });
  } catch (error) {
    logError('aiStore.checkConnection', error);
    try { store.setState({ isConnected: false }); } catch { /* store destroyed */ }
  }
}

// React hook — delegates to the singleton
export function useAIStore<T>(selector: (state: AIStore) => T): T {
  return useStore(getAIStore(), selector);
}
