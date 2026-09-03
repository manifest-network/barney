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
  walletIdentityKey,
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
  return `${STORAGE_KEY_HISTORY_PREFIX}${walletIdentityKey(identity)}`;
}

/**
 * The old global transcript has no trustworthy wallet owner. Discard it
 * instead of silently assigning it to whichever wallet connects first.
 */
export function discardLegacyHistoryStorage(): void {
  historyStorage.clear(LEGACY_STORAGE_KEY_HISTORY);
}

function readRawHistory(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    logError('AIContext.readRawHistory', error);
    return null;
  }
}

/** True when `raw` is an envelope stamped by a NEWER build.
 *
 * `versionedStorage` deliberately treats such a value as unreadable without
 * deleting it, so an older build must neither overwrite nor remove it. The
 * `data` check keeps this a strict subset of `versionedStorage`'s own envelope
 * test: `{"v":2}` with no payload is corrupt rather than future, and is cleaned
 * up like any other unreadable shape instead of blocking writes forever. */
function isFutureHistoryEnvelope(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object'
      && parsed !== null
      && 'v' in parsed
      && 'data' in parsed
      && typeof parsed.v === 'number'
      && Number.isInteger(parsed.v)
      && parsed.v > HISTORY_STORAGE_VERSION;
  } catch {
    return false;
  }
}

/** Re-read storage on every call rather than caching the answer from load: a
 * sibling tab running a newer build can stamp a future envelope at any time,
 * and this tab must not clobber it just because the key looked readable when
 * this tab first opened the wallet. */
function hasFutureHistoryVersion(key: string): boolean {
  const raw = readRawHistory(key);
  return raw !== null && isFutureHistoryEnvelope(raw);
}

export function loadHistory(identity: WalletIdentity): ChatMessage[] {
  const key = historyStorageKey(identity);
  const saved = historyStorage.load(key);
  if (saved && walletIdentitiesEqual(saved.identity, identity)) {
    return rehydrateChatHistory(saved.messages);
  }

  // Nothing usable. Clear the key so the next load stays cheap — but not when
  // it is absent (nothing to remove) or owned by a newer build, whose envelope
  // must survive a temporary downgrade.
  const raw = readRawHistory(key);
  if (raw !== null && !isFutureHistoryEnvelope(raw)) historyStorage.clear(key);
  return [];
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
      const detail = 'The session ended while this transaction was in progress. It may already have been submitted; check its status before retrying.';
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
        error: m.error ?? 'Interrupted — message was incomplete when the session ended.',
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
        content: 'Interrupted — confirmation was pending when the session ended.',
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
  // This preference controls future writes only. Destruction stays an explicit
  // user action (`/clear`, or the confirmed Clear This Wallet's History
  // button), so toggling a setting can never erase another wallet's data.
  if (!saveHistory) return;

  const key = historyStorageKey(identity);
  // Do not let an older build overwrite or delete data it cannot understand.
  // This guards the clear-on-empty branch below as well as the write.
  if (hasFutureHistoryVersion(key)) return;

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
  historyStorage.save(key, { identity, messages: toSave });
}

/** Explicit, user-initiated deletion of one wallet/network transcript. Unlike
 * every automatic write this DOES remove a future-version envelope: the user
 * asked for this wallet's history to be gone. */
export function clearHistoryStorage(identity: WalletIdentity): void {
  historyStorage.clear(historyStorageKey(identity));
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

  // A sibling tab writing a transcript we are holding in the session cache
  // would otherwise be invisible: switching back to that wallet would paint
  // this tab's older copy, and its next write would overwrite the other tab's
  // messages. Drop the cached copy so the next switch-in re-reads storage.
  //
  // The VISIBLE transcript is deliberately left alone — it is live session
  // state (in-flight rows, an open confirmation) that must not be replaced
  // underneath the user. Last writer still wins for a wallet open in two tabs.
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null) {
      // Whole-origin clear (another tab called localStorage.clear()).
      const { historyIdentity, _historyCache } = store.getState();
      const visibleKey = historyIdentity ? walletIdentityKey(historyIdentity) : null;
      for (const key of [..._historyCache.keys()]) {
        if (key !== visibleKey) _historyCache.delete(key);
      }
      return;
    }
    if (!event.key.startsWith(STORAGE_KEY_HISTORY_PREFIX)) return;

    const identityKey = event.key.slice(STORAGE_KEY_HISTORY_PREFIX.length);
    const { historyIdentity, _historyCache } = store.getState();
    if (historyIdentity && walletIdentityKey(historyIdentity) === identityKey) return;
    _historyCache.delete(identityKey);
  };
  window.addEventListener('storage', handleStorage);

  const unsubSettings = store.subscribe(
    (state, prev) => {
      if (state.settings !== prev.settings) {
        saveSettings(state.settings);
      }
    }
  );

  const unsubHistory = store.subscribe(
    (state, prev) => {
      // The browser-global preference controls future writes only. Turning it
      // back on snapshots the selected wallet; no toggle direction ever deletes.
      if (state.settings.saveHistory !== prev.settings.saveHistory) {
        if (state.settings.saveHistory
            && state.historyIdentity
            // An empty transcript has nothing to snapshot, and routing it
            // through the clear-on-empty branch would delete a transcript a
            // sibling tab saved under the same key.
            && state.messages.length > 0) {
          saveHistory(state.historyIdentity, state.messages, true);
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
    window.removeEventListener('storage', handleStorage);
    unsubSettings();
    unsubHistory();
  };
}
