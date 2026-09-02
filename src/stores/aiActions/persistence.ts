/**
 * Persistence actions — load/save settings & history from/to localStorage.
 */

import {
  validateSettings,
  validateChatHistory,
  type AISettings,
} from '../../ai/validation';
import { logError } from '../../utils/errors';
import { createVersionedStorage } from '../../utils/versionedStorage';
import type { WalletIdentity } from '../../utils/walletIdentity';
import {
  createWalletIdentity,
  walletIdentitiesEqual,
} from '../../utils/walletIdentity';
import type { ChatMessage } from '../../contexts/aiTypes';
import type { StoreApi } from 'zustand';
import type { AIStore } from '../aiStore';

const STORAGE_KEY_SETTINGS = 'barney-ai-settings';
const LEGACY_STORAGE_KEY_HISTORY = 'barney-ai-history';
const STORAGE_KEY_HISTORY_PREFIX = 'barney-ai-history:v1:';
const HISTORY_STORAGE_VERSION = 1;

interface PersistedHistory {
  identity: WalletIdentity;
  messages: ChatMessage[];
}

const historyStorage = createVersionedStorage<PersistedHistory>({
  version: HISTORY_STORAGE_VERSION,
  // Scoped history has only ever been written in a v1 envelope. An
  // unversioned value under a scoped key is untrusted and must not be adopted.
  migrations: [() => null],
  validate: (data) => {
    if (typeof data !== 'object' || data === null) return null;

    const candidate = data as Partial<PersistedHistory>;
    if (typeof candidate.identity !== 'object' || candidate.identity === null) return null;
    if (!Array.isArray(candidate.messages)) return null;

    const identity = createWalletIdentity(
      candidate.identity.chainId ?? '',
      candidate.identity.address,
    );
    if (!identity || !walletIdentitiesEqual(identity, candidate.identity as WalletIdentity)) {
      return null;
    }

    return {
      identity,
      messages: validateChatHistory(candidate.messages) as ChatMessage[],
    };
  },
});

export const defaultSettings: AISettings = {
  saveHistory: true,
};

function canonicalHistoryIdentity(identity: WalletIdentity): WalletIdentity {
  const canonical = createWalletIdentity(identity.chainId, identity.address);
  if (!canonical) throw new Error('Wallet history requires a chain ID and wallet address');
  return canonical;
}

export function loadSettings(): AISettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (saved) {
      const validated = validateSettings(JSON.parse(saved));
      return { ...defaultSettings, ...validated };
    }
  } catch (error) {
    logError('AIContext.loadSettings', error);
    localStorage.removeItem(STORAGE_KEY_SETTINGS);
  }
  return defaultSettings;
}

export function historyStorageKey(identity: WalletIdentity): string {
  const canonical = canonicalHistoryIdentity(identity);
  return `${STORAGE_KEY_HISTORY_PREFIX}${encodeURIComponent(canonical.chainId)}:${encodeURIComponent(canonical.address)}`;
}

/**
 * The old global transcript has no trustworthy wallet owner. Discard it
 * instead of silently assigning it to whichever wallet connects first.
 */
export function discardLegacyHistoryStorage(): void {
  historyStorage.clear(LEGACY_STORAGE_KEY_HISTORY);
}

export function loadHistory(identity: WalletIdentity): ChatMessage[] {
  discardLegacyHistoryStorage();

  const canonical = canonicalHistoryIdentity(identity);
  const key = historyStorageKey(canonical);
  const saved = historyStorage.load(key);
  if (!saved || !walletIdentitiesEqual(saved.identity, canonical)) {
    // Corrupt, unversioned, future-version, and identity-mismatched entries all
    // fail closed. Clearing prevents repeated parsing and accidental reuse.
    historyStorage.clear(key);
    return [];
  }

  return rehydrateChatHistory(saved.messages);
}

/**
 * Scrub transient runtime state from messages loaded from localStorage.
 *
 * The persistence subscription already excludes streaming messages from being
 * saved (`saveHistory` filters them), but defensive scrubbing here protects
 * against:
 *   - Tab killed mid-stream → stale persisted message had `isStreaming: true`
 *   - Tab killed mid-confirmation → tool message paired with a now-gone
 *     pendingConfirmation (the confirmation state is intentionally not
 *     persisted, so on reload it can't be confirmed against)
 *
 * Both cases are marked as interrupted so the user sees clear closure.
 */
function rehydrateChatHistory(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.map((m) => {
    // A confirmed transaction can outlive the page. Its broadcast cannot be
    // rolled back, so preserve the row and close it with an outcome-unknown
    // warning rather than pretending confirmation was still pending.
    if (m.role === 'tool' && m.transactionInFlight) {
      const detail = 'The page reloaded while this transaction was in progress. It may already have been submitted; check its status before retrying.';
      return {
        ...m,
        content: detail,
        error: detail,
        isStreaming: false,
        awaitingConfirmation: false,
        transactionInFlight: false,
      };
    }
    // Streaming-in-progress on disk → interrupted. Drop the streaming flag,
    // strip any partial toolCalls (they may contain truncated JSON in
    // function.arguments and would confuse the model on replay), and
    // surface a closure marker on the message itself.
    if (m.isStreaming) {
      return {
        ...m,
        isStreaming: false,
        toolCalls: undefined,
        error: m.error ?? 'Interrupted — message was incomplete when the page reloaded.',
      };
    }
    // Tool message awaiting confirmation when the tab died. The paired
    // pendingConfirmation is intentionally not persisted, so on reload there
    // is nothing to confirm against. Use the structural flag rather than
    // pattern-matching content (executors emit tool-specific
    // confirmationMessage strings that don't share any keyword).
    if (m.role === 'tool' && m.awaitingConfirmation) {
      return {
        ...m,
        content: 'Interrupted — confirmation was pending when the page reloaded.',
        error: 'Interrupted',
        awaitingConfirmation: false,
      };
    }
    return m;
  });
}

export function saveSettings(settings: AISettings): void {
  try {
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
  } catch (error) {
    logError('AIContext.saveSettings', error);
  }
}

export function saveHistory(
  identity: WalletIdentity,
  messages: ChatMessage[],
  saveHistory: boolean,
): void {
  const canonical = canonicalHistoryIdentity(identity);
  const key = historyStorageKey(canonical);
  if (saveHistory) {
    // Strip `card` and `toolCalls` from messages before persisting.
    //
    // The strip is INTENTIONAL — do not "fix" it by adding `card` to
    // PersistedMessageSchema in `ai/validation.ts`. Cards snapshot live
    // state (DNS status, lease shape, balances) at the moment the message
    // was emitted. Rehydrating them after a reload would surface stale
    // data that disagrees with the chain.
    //
    // Recovery path for custom-domain cards specifically:
    //   - The sidebar custom-domain dot stays live because
    //     `useDnsStatusPolling` iterates the wallet's app registry,
    //     not chat history.
    //   - The inline `CustomDomainCard` re-emits when the user runs
    //     `app_status` — `compositeQueries.executeAppStatus` already
    //     attaches `displayCard: { type: 'custom_domain' }` for
    //     single-domain leases.
    //
    // Belt-and-suspenders: PersistedMessageSchema doesn't whitelist
    // `card` either, so anything that leaks through this filter is
    // dropped by Zod on rehydrate.
    const toSave = messages
      .filter((m) => !m.isStreaming)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see comment above
      .map(({ card, toolCalls, ...rest }) =>
        card ? { ...rest, content: `[${card.type} displayed to user]` } : rest
      );
    if (toSave.length === 0) {
      historyStorage.clear(key);
      return;
    }
    historyStorage.save(key, { identity: canonical, messages: toSave });
  } else {
    historyStorage.clear(key);
  }
}

export function clearHistoryStorage(identity: WalletIdentity): void {
  historyStorage.clear(historyStorageKey(identity));
}

/** Delete every wallet-scoped transcript. The save-history preference is
 * browser-global, so turning it off must not leave another wallet's history
 * retained merely because that wallet is not currently connected. */
export function clearAllHistoryStorage(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key === LEGACY_STORAGE_KEY_HISTORY || key?.startsWith(STORAGE_KEY_HISTORY_PREFIX)) {
        keys.push(key);
      }
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch (error) {
    logError('AIContext.clearAllHistoryStorage', error);
  }
}

/** Detect changes to the non-streaming subset without serializing on every
 * token frame. Store actions preserve object identity for untouched messages,
 * so a same-length transition (confirmation → in-flight, in-flight → result)
 * is observable while streaming assistant updates remain free. */
function persistableMessagesChanged(
  messages: ChatMessage[],
  previousMessages: ChatMessage[],
): boolean {
  const persistable = messages.filter((message) => !message.isStreaming);
  const previousPersistable = previousMessages.filter((message) => !message.isStreaming);
  if (persistable.length !== previousPersistable.length) return true;
  return persistable.some((message, index) => message !== previousPersistable[index]);
}

/**
 * Set up Zustand subscriptions that persist settings and history to localStorage.
 * Returns an unsubscribe function.
 */
export function setupPersistenceSubscriptions(store: StoreApi<AIStore>): () => void {
  // Safe migration for the former browser-global transcript. There is no way
  // to establish which wallet owned it, so startup always discards it.
  discardLegacyHistoryStorage();
  if (!store.getState().settings.saveHistory) clearAllHistoryStorage();

  const unsubSettings = store.subscribe(
    (state, prev) => {
      if (state.settings !== prev.settings) {
        saveSettings(state.settings);
      }
    }
  );

  const unsubHistory = store.subscribe(
    (state, prev) => {
      // The preference is browser-global. Turning it off deletes every scoped
      // transcript even when no wallet is connected; turning it on starts by
      // saving only the currently selected wallet, if any.
      if (state.settings.saveHistory !== prev.settings.saveHistory) {
        if (state.settings.saveHistory) {
          if (state.historyIdentity) {
            saveHistory(state.historyIdentity, state.messages, true);
          }
        } else {
          clearAllHistoryStorage();
        }
        return;
      }

      // Identity transitions are persisted and rehydrated synchronously by
      // setWalletContext. Never let this subscriber write the newly selected
      // transcript using messages from the prior identity (or from disconnect).
      if (!walletIdentitiesEqual(state.historyIdentity, prev.historyIdentity)) return;

      const identity = state.historyIdentity;
      if (!identity) return;
      // Stream-end safety flush: persist the completed turn once on the
      // isStreaming true -> false transition (the finally flips the flag without
      // touching messages, so the diff branch below wouldn't fire for it).
      if (prev.isStreaming && !state.isStreaming) {
        saveHistory(identity, state.messages, state.settings.saveHistory);
        return;
      }
      if (state.messages === prev.messages) return;
      // Not streaming — any message change is a persisted-history change.
      if (!state.isStreaming) {
        saveHistory(identity, state.messages, state.settings.saveHistory);
        return;
      }
      // Streaming: skip ~60/s token updates, but persist any added, removed, or
      // changed NON-streaming row immediately. Comparing references catches
      // same-count state changes such as pending confirmation → confirmed TX.
      if (persistableMessagesChanged(state.messages, prev.messages)) {
        saveHistory(identity, state.messages, state.settings.saveHistory);
      }
    }
  );

  return () => {
    unsubSettings();
    unsubHistory();
  };
}
