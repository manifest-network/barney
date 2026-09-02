import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../ai/validation', () => ({
  validateSettings: vi.fn((data: unknown) => data),
  validateChatHistory: vi.fn((data: unknown) => (Array.isArray(data) ? data : [])),
}));

vi.mock('../../utils/errors', () => ({
  logError: vi.fn(),
}));

import { createStore } from 'zustand/vanilla';
import {
  loadSettings,
  loadHistory,
  saveSettings,
  saveHistory,
  clearHistoryStorage,
  clearAllHistoryStorage,
  discardLegacyHistoryStorage,
  historyStorageKey,
  setupPersistenceSubscriptions,
  defaultSettings,
} from './persistence';
import { validateSettings, validateChatHistory } from '../../ai/validation';
import { logError } from '../../utils/errors';
import type { ChatMessage } from '../../contexts/aiTypes';
import type { AISettings } from '../../ai/validation';
import type { StoreApi } from 'zustand';
import type { AIStore } from '../aiStore';
import { createWalletIdentity } from '../../utils/walletIdentity';

const STORAGE_KEY_SETTINGS = 'barney-ai-settings';
const LEGACY_STORAGE_KEY_HISTORY = 'barney-ai-history';
const IDENTITY = createWalletIdentity('manifest-test', '  MANIFEST1ALICE  ')!;
const STORAGE_KEY_HISTORY = historyStorageKey(IDENTITY);

function storeHistory(messages: ChatMessage[]): void {
  localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify({
    v: 1,
    data: { identity: IDENTITY, messages },
  }));
}

function storedMessages(): ChatMessage[] {
  return JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY)!).data.messages;
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    role: 'user',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('persistence actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  // ---- loadSettings ----

  describe('loadSettings', () => {
    it('returns defaults when localStorage is empty', () => {
      const result = loadSettings();
      expect(result).toEqual(defaultSettings);
    });

    it('parses valid JSON from localStorage', () => {
      const saved = { saveHistory: false };
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(saved));
      const result = loadSettings();
      expect(validateSettings).toHaveBeenCalledWith(saved);
      expect(result.saveHistory).toBe(false);
    });

    it('returns defaults and clears on corrupt JSON', () => {
      localStorage.setItem(STORAGE_KEY_SETTINGS, '{broken json');
      const result = loadSettings();
      expect(result).toEqual(defaultSettings);
      expect(logError).toHaveBeenCalled();
      expect(localStorage.getItem(STORAGE_KEY_SETTINGS)).toBeNull();
    });
  });

  // ---- loadHistory ----

  describe('loadHistory', () => {
    it('derives the key from the exact chain ID and normalized address', () => {
      const identity = createWalletIdentity(' chain/with:punctuation ', ' MANIFEST1ALICE ')!;

      expect(identity).toEqual({
        chainId: 'chain/with:punctuation',
        address: 'manifest1alice',
      });
      expect(historyStorageKey(identity)).toBe(
        'barney-ai-history:v1:chain%2Fwith%3Apunctuation:manifest1alice',
      );
    });

    it('returns [] when localStorage is empty', () => {
      expect(loadHistory(IDENTITY)).toEqual([]);
    });

    it('discards valid legacy global history instead of assigning it', () => {
      localStorage.setItem(
        LEGACY_STORAGE_KEY_HISTORY,
        JSON.stringify([makeMessage({ content: 'wallet owner is unknown' })]),
      );

      expect(loadHistory(IDENTITY)).toEqual([]);
      expect(localStorage.getItem(LEGACY_STORAGE_KEY_HISTORY)).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY_HISTORY)).toBeNull();
    });

    it('discards malformed legacy global history without parsing or importing it', () => {
      localStorage.setItem(LEGACY_STORAGE_KEY_HISTORY, '{malformed');

      expect(() => discardLegacyHistoryStorage()).not.toThrow();
      expect(localStorage.getItem(LEGACY_STORAGE_KEY_HISTORY)).toBeNull();
    });

    it('validates and returns saved messages', () => {
      const msgs = [makeMessage({ id: 'm1' }), makeMessage({ id: 'm2' })];
      storeHistory(msgs);
      const result = loadHistory(IDENTITY);
      expect(validateChatHistory).toHaveBeenCalledWith(msgs);
      expect(result).toHaveLength(2);
    });

    it('returns [] and clears on corrupt data', () => {
      localStorage.setItem(STORAGE_KEY_HISTORY, 'not-json-at-all');
      const result = loadHistory(IDENTITY);
      expect(result).toEqual([]);
      expect(logError).toHaveBeenCalled();
      expect(localStorage.getItem(STORAGE_KEY_HISTORY)).toBeNull();
    });

    it('rejects an envelope whose identity does not match its scoped key', () => {
      const otherIdentity = createWalletIdentity('manifest-other', 'manifest1bob')!;
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify({
        v: 1,
        data: {
          identity: otherIdentity,
          messages: [makeMessage({ content: 'belongs elsewhere' })],
        },
      }));

      expect(loadHistory(IDENTITY)).toEqual([]);
      expect(localStorage.getItem(STORAGE_KEY_HISTORY)).toBeNull();
    });

    it('clears isStreaming on rehydrated messages and surfaces an interrupted error', () => {
      const msgs = [makeMessage({ id: 'm1', isStreaming: true, content: 'half-streamed' })];
      storeHistory(msgs);
      const result = loadHistory(IDENTITY);
      expect(result[0].isStreaming).toBe(false);
      expect(result[0].error).toMatch(/interrupted/i);
    });

    it('rewrites tool messages with awaitingConfirmation=true with an interrupted error', () => {
      const msgs = [makeMessage({
        id: 'm1',
        role: 'tool',
        content: 'Deploy "redis" on micro tier?',
        awaitingConfirmation: true,
      })];
      storeHistory(msgs);
      const result = loadHistory(IDENTITY);
      expect(result[0].error).toBe('Interrupted');
      expect(result[0].content).toMatch(/interrupted/i);
      expect(result[0].awaitingConfirmation).toBe(false);
    });

    it('replaces a retryable re-plan error when its confirmation cannot survive reload', () => {
      const msgs = [makeMessage({
        id: 'm1',
        role: 'tool',
        content: 'Deploy 2 apps?',
        error: 'Tier catalog unavailable',
        awaitingConfirmation: true,
      })];
      storeHistory(msgs);

      const result = loadHistory(IDENTITY);

      expect(result[0]).toMatchObject({
        content: 'Interrupted — confirmation was pending when the page reloaded.',
        error: 'Interrupted',
        awaitingConfirmation: false,
      });
    });

    it('rewrites an in-flight transaction with a broadcast-aware reload warning', () => {
      const msgs = [makeMessage({
        id: 'm1',
        role: 'tool',
        content: 'Deploy "redis"?',
        transactionInFlight: true,
      })];
      storeHistory(msgs);

      const result = loadHistory(IDENTITY);

      expect(result[0].content).toContain('page reloaded');
      expect(result[0].error).toContain('may already have been submitted');
      expect(result[0].transactionInFlight).toBe(false);
    });

    it('does NOT rewrite tool messages with confirmation-prompt content but no awaitingConfirmation flag', () => {
      const msgs = [makeMessage({
        id: 'm1',
        role: 'tool',
        content: 'Deploy "redis" on micro tier?',
      })];
      storeHistory(msgs);
      const result = loadHistory(IDENTITY);
      expect(result[0].error).toBeUndefined();
      expect(result[0].content).toBe('Deploy "redis" on micro tier?');
    });

    it('strips toolCalls from interrupted streaming messages', () => {
      const msgs = [makeMessage({
        id: 'm1',
        role: 'assistant',
        content: '',
        isStreaming: true,
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'deploy_app', arguments: { partial: 'truncated' } } }] as any,
      })];
      storeHistory(msgs);
      const result = loadHistory(IDENTITY);
      expect(result[0].toolCalls).toBeUndefined();
    });

    it('leaves normal completed messages untouched', () => {
      const msgs = [
        makeMessage({ id: 'u1', role: 'user', content: 'hi' }),
        makeMessage({ id: 'a1', role: 'assistant', content: 'hello!' }),
      ];
      storeHistory(msgs);
      const result = loadHistory(IDENTITY);
      expect(result[0].error).toBeUndefined();
      expect(result[1].error).toBeUndefined();
      expect(result[1].content).toBe('hello!');
    });
  });

  // ---- saveSettings ----

  describe('saveSettings', () => {
    it('writes JSON to localStorage', () => {
      const settings: AISettings = { ...defaultSettings, saveHistory: false };
      saveSettings(settings);
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_SETTINGS)!);
      expect(stored.saveHistory).toBe(false);
    });
  });

  // ---- saveHistory ----

  describe('saveHistory', () => {
    it('writes a versioned envelope containing the normalized identity', () => {
      saveHistory(IDENTITY, [makeMessage({ id: 'm1' })], true);

      expect(JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY)!)).toMatchObject({
        v: 1,
        data: {
          identity: IDENTITY,
          messages: [{ id: 'm1' }],
        },
      });
    });

    it('filters out streaming messages', () => {
      const msgs = [
        makeMessage({ id: 'm1', isStreaming: false }),
        makeMessage({ id: 'm2', isStreaming: true }),
      ];
      saveHistory(IDENTITY, msgs, true);
      const stored = storedMessages();
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe('m1');
    });

    it('strips card and toolCalls, replacing card content', () => {
      const msgs = [
        makeMessage({
          id: 'm1',
          role: 'assistant',
          content: 'original',
          card: { type: 'help', data: null },
          toolCalls: [{ id: 'tc1', type: 'function' as const, function: { name: 'list_apps', arguments: {} } }],
        }),
      ];
      saveHistory(IDENTITY, msgs, true);
      const stored = storedMessages();
      expect(stored[0].content).toBe('[help displayed to user]');
      expect(stored[0].card).toBeUndefined();
      expect(stored[0].toolCalls).toBeUndefined();
    });

    it('removes localStorage key when saveHistory is false', () => {
      localStorage.setItem(STORAGE_KEY_HISTORY, 'some data');
      saveHistory(IDENTITY, [], false);
      expect(localStorage.getItem(STORAGE_KEY_HISTORY)).toBeNull();
    });

    it('removes the scoped key when no persistable messages remain', () => {
      localStorage.setItem(STORAGE_KEY_HISTORY, 'some data');

      saveHistory(IDENTITY, [], true);

      expect(localStorage.getItem(STORAGE_KEY_HISTORY)).toBeNull();
    });
  });

  // ---- clearHistoryStorage ----

  describe('clearHistoryStorage', () => {
    it('removes the history key', () => {
      localStorage.setItem(STORAGE_KEY_HISTORY, 'data');
      clearHistoryStorage(IDENTITY);
      expect(localStorage.getItem(STORAGE_KEY_HISTORY)).toBeNull();
    });

    it('can clear every scoped wallet history without touching unrelated state', () => {
      const otherIdentity = createWalletIdentity('manifest-other', 'manifest1bob')!;
      saveHistory(IDENTITY, [makeMessage()], true);
      saveHistory(otherIdentity, [makeMessage()], true);
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(defaultSettings));

      clearAllHistoryStorage();

      expect(localStorage.getItem(STORAGE_KEY_HISTORY)).toBeNull();
      expect(localStorage.getItem(historyStorageKey(otherIdentity))).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY_SETTINGS)).not.toBeNull();
    });
  });

  // ---- setupPersistenceSubscriptions ----

  describe('setupPersistenceSubscriptions', () => {
    function createMiniStore() {
      return createStore(() => ({
        settings: { ...defaultSettings },
        messages: [] as ChatMessage[],
        isStreaming: false,
        historyIdentity: IDENTITY,
      })) as unknown as StoreApi<AIStore>;
    }

    it('fires saveSettings on settings change', () => {
      const miniStore = createMiniStore();
      const unsub = setupPersistenceSubscriptions(miniStore);

      miniStore.setState({ settings: { ...defaultSettings, saveHistory: false } });

      const stored = localStorage.getItem(STORAGE_KEY_SETTINGS);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).saveHistory).toBe(false);

      unsub();
    });

    it('turning history off while disconnected deletes every wallet transcript', () => {
      const otherIdentity = createWalletIdentity('manifest-other', 'manifest1bob')!;
      saveHistory(IDENTITY, [makeMessage()], true);
      saveHistory(otherIdentity, [makeMessage()], true);
      const miniStore = createMiniStore();
      miniStore.setState({ historyIdentity: null });
      const unsub = setupPersistenceSubscriptions(miniStore);

      miniStore.setState({ settings: { ...defaultSettings, saveHistory: false } });

      expect(localStorage.getItem(STORAGE_KEY_HISTORY)).toBeNull();
      expect(localStorage.getItem(historyStorageKey(otherIdentity))).toBeNull();

      unsub();
    });

    it('fires saveHistory on messages change', () => {
      const miniStore = createMiniStore();
      const unsub = setupPersistenceSubscriptions(miniStore);

      miniStore.setState({ messages: [makeMessage()] });

      const stored = localStorage.getItem(STORAGE_KEY_HISTORY);
      expect(stored).not.toBeNull();

      unsub();
    });

    it('skips per-frame updates to the streaming assistant (persisted subset unchanged)', () => {
      const miniStore = createMiniStore();
      const unsub = setupPersistenceSubscriptions(miniStore);

      miniStore.setState({ isStreaming: true });
      localStorage.clear();

      // ~60x/s content updates to the STREAMING assistant message (isStreaming:
      // true, excluded from persistence) don't change the persisted subset, so
      // none of these should write.
      miniStore.setState({ messages: [makeMessage({ id: 'a1', role: 'assistant', content: 'H', isStreaming: true })] });
      localStorage.clear();
      miniStore.setState({ messages: [makeMessage({ id: 'a1', role: 'assistant', content: 'Hel', isStreaming: true })] });
      miniStore.setState({ messages: [makeMessage({ id: 'a1', role: 'assistant', content: 'Hello', isStreaming: true })] });

      expect(localStorage.getItem(STORAGE_KEY_HISTORY)).toBeNull();

      unsub();
    });

    it('persists a non-streaming message appended mid-stream (no lost turn on crash)', () => {
      const miniStore = createMiniStore();
      const unsub = setupPersistenceSubscriptions(miniStore);

      // sendMessage sets isStreaming:true BEFORE appending the user message.
      miniStore.setState({ isStreaming: true });
      localStorage.clear();

      // The user's message is appended while streaming — it grows the persisted
      // subset and must be written now, not deferred to stream-end (else a
      // mid-stream reload/crash loses it).
      miniStore.setState({ messages: [makeMessage({ id: 'u1', role: 'user', content: 'hi' })] });

      const stored = localStorage.getItem(STORAGE_KEY_HISTORY);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).data.messages).toHaveLength(1);
      expect(JSON.parse(stored!).data.messages[0].id).toBe('u1');

      unsub();
    });

    it('persists a same-count confirmation-to-transaction transition mid-stream', () => {
      const pendingTool = makeMessage({
        id: 'tool-1',
        role: 'tool',
        content: 'Deploy?',
        awaitingConfirmation: true,
        isStreaming: false,
      });
      const miniStore = createMiniStore();
      miniStore.setState({ messages: [makeMessage({ id: 'u1' }), pendingTool] });
      saveHistory(IDENTITY, miniStore.getState().messages, true);
      const unsub = setupPersistenceSubscriptions(miniStore);

      miniStore.setState({
        isStreaming: true,
        messages: miniStore.getState().messages.map((message) =>
          message.id === pendingTool.id
            ? {
                ...message,
                awaitingConfirmation: false,
                transactionInFlight: true,
              }
            : message
        ),
      });

      const stored = storedMessages();
      expect(stored.map((message: ChatMessage) => message.id)).toEqual(['u1', 'tool-1']);
      expect(stored[1]).toMatchObject({
        isStreaming: false,
        awaitingConfirmation: false,
        transactionInFlight: true,
      });

      unsub();
    });

    it('flushes final history once when streaming ends', () => {
      const miniStore = createMiniStore();
      const unsub = setupPersistenceSubscriptions(miniStore);

      // Streaming in progress with a completed messages array already set.
      const finalMessages = [makeMessage({ id: 'a1', role: 'assistant', content: 'done' })];
      miniStore.setState({ isStreaming: true, messages: finalMessages });
      localStorage.clear();

      // The finally flips isStreaming false WITHOUT touching messages (same
      // reference). The true->false branch is what flushes the completed turn.
      miniStore.setState({ isStreaming: false });

      const stored = localStorage.getItem(STORAGE_KEY_HISTORY);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).data.messages).toHaveLength(1);
      expect(JSON.parse(stored!).data.messages[0].id).toBe('a1');

      unsub();
    });

    it('unsubscribe prevents further saves', () => {
      const miniStore = createMiniStore();
      const unsub = setupPersistenceSubscriptions(miniStore);
      unsub();

      localStorage.clear();
      miniStore.setState({ settings: { ...defaultSettings, saveHistory: false } });

      expect(localStorage.getItem(STORAGE_KEY_SETTINGS)).toBeNull();
    });
  });
});
