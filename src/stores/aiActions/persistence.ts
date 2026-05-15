/**
 * Persistence actions — load/save settings & history from/to localStorage.
 */

import {
  validateSettings,
  validateChatHistory,
  type AISettings,
} from '../../ai/validation';
import { logError } from '../../utils/errors';
import type { ChatMessage } from '../../contexts/aiTypes';
import type { StoreApi } from 'zustand';
import type { AIStore } from '../aiStore';

const STORAGE_KEY_SETTINGS = 'barney-ai-settings';
const STORAGE_KEY_HISTORY = 'barney-ai-history';

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

export function loadHistory(): ChatMessage[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_HISTORY);
    if (saved) {
      const validated = validateChatHistory(JSON.parse(saved)) as ChatMessage[];
      return rehydrateChatHistory(validated);
    }
  } catch (error) {
    logError('AIContext.loadHistory', error);
    localStorage.removeItem(STORAGE_KEY_HISTORY);
  }
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
    if (m.role === 'tool' && m.awaitingConfirmation && !m.error) {
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

export function saveHistory(messages: ChatMessage[], saveHistory: boolean): void {
  if (saveHistory) {
    try {
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
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(toSave));
    } catch (error) {
      logError('AIContext.saveHistory', error);
    }
  } else {
    localStorage.removeItem(STORAGE_KEY_HISTORY);
  }
}

export function clearHistoryStorage(): void {
  localStorage.removeItem(STORAGE_KEY_HISTORY);
}

/**
 * Set up Zustand subscriptions that persist settings and history to localStorage.
 * Returns an unsubscribe function.
 */
export function setupPersistenceSubscriptions(store: StoreApi<AIStore>): () => void {
  const unsubSettings = store.subscribe(
    (state, prev) => {
      if (state.settings !== prev.settings) {
        saveSettings(state.settings);
      }
    }
  );

  const unsubHistory = store.subscribe(
    (state, prev) => {
      if (state.messages !== prev.messages || state.settings.saveHistory !== prev.settings.saveHistory) {
        saveHistory(state.messages, state.settings.saveHistory);
      }
    }
  );

  return () => {
    unsubSettings();
    unsubHistory();
  };
}
