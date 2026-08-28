/**
 * Zustand vanilla store factory for AI chat state.
 * Instances are owned by `AIProvider` and consumed via `useAIStore` from
 * `contexts/aiStoreContext`.
 */

import { createStore } from 'zustand/vanilla';
import type { CosmosClientManager } from '@manifest-network/manifest-sdk';
import { checkApiHealth } from '../api/morpheus';
import type { AISettings } from '../ai/validation';
import type { PayloadAttachment, ToolResult, SigningContext } from '../ai/toolExecutor';
import type { DeployProgress } from '../ai/progress';
import { validateFile, validateManifestContent } from '../utils/fileValidation';
import { sha256, toHex } from '../utils/hash';
import { logError } from '../utils/errors';
import {
  AI_TOOL_CACHE_TTL_MS,
  AI_TOOL_CACHE_MAX_SIZE,
} from '../config/constants';
import type { ChatMessage, PendingConfirmation, MessageCard } from '../contexts/aiTypes';
import type { CustomDomainStatusKind } from '../utils/customDomainStatus';
import { CHAIN_ID } from '../config/chain';
import {
  ACTIVE_WORK_CANCELLED_MESSAGE,
  AUTHORIZATION_CANCELLED_MESSAGE,
  AUTHORIZATION_CHANGED_ERROR,
} from './authorization';

/** Per-domain status report stored in the dnsStatuses map. The map key is
 *  `${leaseUuid}::${customDomain}` so multi-domain stacks don't collide. */
export interface DnsStatusEntry {
  leaseUuid: string;
  customDomain: string;
  serviceName: string;
  kind: CustomDomainStatusKind;
  /** The provider FQDN the user's CNAME should point at. May be undefined
   *  briefly while connection metadata refreshes. */
  expectedCnameTarget?: string;
  /** Free-form sub-reason from `computeStatus` (today: only set on the
   *  wrong-target case, future: server-side reasons like "acme_rate_limited"). */
  detail?: string;
}

export const dnsStatusKey = (leaseUuid: string, customDomain: string) =>
  `${leaseUuid}::${customDomain}`;

import { loadSettings, loadHistory, clearHistoryStorage } from './aiActions/persistence';
import { scheduleStreamingUpdateFn, flushPendingUpdateFn } from './aiActions/streaming';
import { sendMessageFn } from './aiActions/sendMessage';
import { confirmActionFn, cancelActionFn, type ConfirmActionOverrides } from './aiActions/confirmAction';
import { requestBatchDeployFn } from './aiActions/batchDeploy';
import { requestStopAppFn } from './aiActions/stopApp';
import {
  loadSkuTiersFn,
  retrySkuTiersFn,
  initialSkuTiersState,
  type SkuTiersState,
} from './aiActions/skuTiers';
import { generateMessageId, trimMessages } from './aiActions/utils';

// Re-export for use by action modules and consumers
export { generateMessageId };

// Re-export types for backward compatibility
export type { ChatMessage, PendingConfirmation } from '../contexts/aiTypes';
export type { AISettings } from '../ai/validation';
export type { SkuTiersState } from './aiActions/skuTiers';

export interface AIStore {
  // --- Reactive state (components select these) ---
  isOpen: boolean;
  messages: ChatMessage[];
  isStreaming: boolean;
  isConnected: boolean;
  settings: AISettings;
  pendingConfirmation: PendingConfirmation | null;
  pendingPayload: PayloadAttachment | null;
  deployProgress: DeployProgress | null;

  /** DNS resolution status by `dnsStatusKey(leaseUuid, customDomain)`. Driven
   *  by the per-tab polling loop in MainLayout; consumed by AppsSidebar (dot),
   *  the CustomDomainCard, and the AppCard's embedded custom-domain row. */
  dnsStatuses: ReadonlyMap<string, DnsStatusEntry>;

  /** Resolved SKU tier list (chain ∩ env), loaded once at boot. Deploy
   *  surfaces are never disabled by tier state; the executor falls back to the
   *  cheapest tier for an omitted/unavailable size and returns 'Tier catalog
   *  unavailable' only for an empty list. */
  skuTiers: SkuTiersState;

  // --- Internal state (only accessed via get() in actions) ---
  clientManager: CosmosClientManager | null;
  address: string | undefined;
  signing: SigningContext | undefined;
  chainId: string;
  /** Monotonic identities for concrete SDK client/signer instances. */
  clientGeneration: number;
  signerGeneration: number;
  /** Changes whenever any authorization-relevant wallet context changes. Async
   * actions capture this epoch so late results cannot repopulate cleared state. */
  authorizationEpoch: number;
  abortController: AbortController | null;
  lastMessageTime: number;
  _toolCache: Map<string, { result: ToolResult; timestamp: number }>;
  _pendingStreamUpdate: { messageId: string; content: string; thinking?: string } | null;
  _rafId: number | null;
  _skuTiersInFlight: Promise<void> | null;

  // --- Actions ---
  setIsOpen: (open: boolean) => void;
  sendMessage: (content: string) => Promise<void>;
  confirmAction: (overrides?: ConfirmActionOverrides) => Promise<void>;
  cancelAction: () => void;
  addMessage: (message: ChatMessage) => void;
  updateMessageById: (messageId: string, updates: Partial<ChatMessage>) => void;
  getCurrentMessages: (excludeId?: string) => ChatMessage[];
  attachPayload: (file: File) => Promise<{ error?: string }>;
  clearPayload: () => void;
  setClientManager: (manager: CosmosClientManager | null) => void;
  setAddress: (address: string | undefined) => void;
  setSigning: (ctx: SigningContext | undefined) => void;
  setChainId: (chainId: string) => void;
  setWalletContext: (context: {
    clientManager: CosmosClientManager | null;
    address: string | undefined;
    signing: SigningContext | undefined;
    chainId: string;
  }) => void;
  setDnsStatuses: (statuses: ReadonlyMap<string, DnsStatusEntry>) => void;
  updateSettings: (settings: Partial<AISettings>) => void;
  clearHistory: () => void;
  requestBatchDeploy: (apps: Array<{ label: string; manifest: object }>, userMessage?: string) => Promise<void>;
  requestStopApp: (appName: string) => void;
  loadSkuTiers: () => Promise<void>;
  retrySkuTiers: () => Promise<void>;
  addLocalMessage: (content: string, card?: MessageCard) => void;
  addLocalErrorMessage: (error: string) => void;
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

function messagesAfterAuthorizationChange(state: AIStore): ChatMessage[] {
  const messages = state.messages.map((message) => {
    if (state.pendingConfirmation?.messageId === message.id) {
      return {
        ...message,
        content: AUTHORIZATION_CANCELLED_MESSAGE,
        error: AUTHORIZATION_CHANGED_ERROR,
        isStreaming: false,
        awaitingConfirmation: false,
      };
    }

    if (message.isStreaming) {
      if (message.role === 'tool') {
        return {
          ...message,
          content: ACTIVE_WORK_CANCELLED_MESSAGE,
          error: AUTHORIZATION_CHANGED_ERROR,
          isStreaming: false,
          awaitingConfirmation: false,
        };
      }
      return { ...message, isStreaming: false };
    }

    return message;
  });

  const hadActiveWork = state.isStreaming
    || state.abortController !== null
    || state.pendingConfirmation !== null
    || state.pendingPayload !== null
    || (state.deployProgress !== null
      && state.deployProgress.phase !== 'ready'
      && state.deployProgress.phase !== 'failed');

  if (hadActiveWork) {
    messages.push({
      id: generateMessageId(),
      role: 'assistant',
      content: state.pendingConfirmation
        ? AUTHORIZATION_CANCELLED_MESSAGE
        : ACTIVE_WORK_CANCELLED_MESSAGE,
      timestamp: Date.now(),
      local: true,
    });
  }

  return trimMessages(messages);
}

export const createAIStore = () =>
  createStore<AIStore>((set, get) => ({
    // --- Initial state ---
    isOpen: false,
    messages: loadHistory(),
    isStreaming: false,
    isConnected: false,
    settings: loadSettings(),
    pendingConfirmation: null,
    pendingPayload: null,
    deployProgress: null,
    dnsStatuses: new Map<string, DnsStatusEntry>(),
    skuTiers: initialSkuTiersState,

    clientManager: null,
    address: undefined,
    signing: undefined,
    chainId: CHAIN_ID,
    clientGeneration: 0,
    signerGeneration: 0,
    authorizationEpoch: 0,
    abortController: null,
    lastMessageTime: 0,
    _toolCache: new Map(),
    _pendingStreamUpdate: null,
    _rafId: null,
    _skuTiersInFlight: null,

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
        local: true,
      };
      set({ messages: trimMessages([...get().messages, msg]) });
    },

    /** UI-synthesized error message — renders via `MessageBubble`'s inline-alert
     *  path and gets `ERROR_PATTERNS` suggestion buttons. Sibling of
     *  `addLocalMessage`; differs only in setting `error` instead of `content`. */
    addLocalErrorMessage: (error) => {
      const msg: ChatMessage = {
        id: generateMessageId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        error,
        local: true,
      };
      set({ messages: trimMessages([...get().messages, msg]) });
    },

    stopStreaming: () => {
      get().abortController?.abort();
    },

    // --- Wallet setters ---
    setWalletContext: (context) => {
      const current = get();
      const clientChanged = context.clientManager !== current.clientManager;
      const addressChanged = context.address !== current.address;
      const signerChanged = context.signing !== current.signing;
      const chainChanged = context.chainId !== current.chainId;
      if (!clientChanged && !addressChanged && !signerChanged && !chainChanged) return;

      // Abort first, then publish the new identity and the complete cleared
      // authorization state in one Zustand update. The epoch/generation checks
      // in async actions make any callbacks already queued by the old work inert.
      current.abortController?.abort();
      if (current._rafId !== null) cancelAnimationFrame(current._rafId);
      current._toolCache.clear();

      set({
        ...context,
        clientGeneration: current.clientGeneration + (clientChanged ? 1 : 0),
        signerGeneration: current.signerGeneration + (signerChanged ? 1 : 0),
        authorizationEpoch: current.authorizationEpoch + 1,
        pendingConfirmation: null,
        pendingPayload: null,
        deployProgress: null,
        dnsStatuses: new Map(),
        abortController: null,
        isStreaming: false,
        _pendingStreamUpdate: null,
        _rafId: null,
        messages: messagesAfterAuthorizationChange(current),
      });
    },

    setClientManager: (manager) => {
      const current = get();
      current.setWalletContext({
        clientManager: manager,
        address: current.address,
        signing: current.signing,
        chainId: current.chainId,
      });
    },

    setAddress: (address) => {
      const current = get();
      current.setWalletContext({
        clientManager: current.clientManager,
        address,
        signing: current.signing,
        chainId: current.chainId,
      });
    },

    setSigning: (signing) => {
      const current = get();
      current.setWalletContext({
        clientManager: current.clientManager,
        address: current.address,
        signing,
        chainId: current.chainId,
      });
    },

    setChainId: (chainId) => {
      const current = get();
      current.setWalletContext({
        clientManager: current.clientManager,
        address: current.address,
        signing: current.signing,
        chainId,
      });
    },

    setDnsStatuses: (statuses) => {
      set({ dnsStatuses: statuses });
    },

    // --- Payload attachment ---
    attachPayload: async (file) => {
      const authorizationEpoch = get().authorizationEpoch;
      const validation = validateFile(file);
      if (!validation.valid) {
        return { error: validation.error };
      }

      try {
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        const contentValidation = validateManifestContent(bytes);
        if (!contentValidation.valid) {
          return { error: contentValidation.error };
        }

        const hashBytes = await sha256(bytes);
        const hash = toHex(hashBytes);

        if (get().authorizationEpoch !== authorizationEpoch) {
          return { error: ACTIVE_WORK_CANCELLED_MESSAGE };
        }

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

        if (typeof newSettings.saveHistory === 'boolean') {
          updated.saveHistory = newSettings.saveHistory;
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

    // --- Streaming ---
    scheduleStreamingUpdate: (messageId, content, thinking) => {
      scheduleStreamingUpdateFn(get, set, messageId, content, thinking);
    },

    flushPendingUpdate: () => {
      flushPendingUpdateFn(get, set);
    },

    // --- Complex actions ---
    sendMessage: (content) => sendMessageFn(get, set, content),
    confirmAction: (overrides) => confirmActionFn(get, set, overrides),
    cancelAction: () => cancelActionFn(get, set),
    requestBatchDeploy: (apps, userMessage) => requestBatchDeployFn(get, set, apps, userMessage),
    requestStopApp: (appName) => requestStopAppFn(get, set, appName),
    loadSkuTiers: () => loadSkuTiersFn(get, set),
    retrySkuTiers: () => retrySkuTiersFn(get, set),

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
    },
  }));

/** Check AI API connection health and update store */
export async function checkConnection(store: ReturnType<typeof createAIStore>): Promise<void> {
  try {
    const healthy = await checkApiHealth();
    store.setState({ isConnected: healthy });
  } catch (error) {
    logError('aiStore.checkConnection', error);
    store.setState({ isConnected: false });
  }
}
