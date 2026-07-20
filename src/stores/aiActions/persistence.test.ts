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
  setupPersistenceSubscriptions,
  defaultSettings,
} from './persistence';
import { validateSettings, validateChatHistory } from '../../ai/validation';
import { logError } from '../../utils/errors';
import type { ChatMessage } from '../../contexts/aiTypes';
import type { AISettings } from '../../ai/validation';
import type { StoreApi } from 'zustand';
import type { AIStore } from '../aiStore';

const STORAGE_KEY_SETTINGS = 'barney-ai-settings';
const STORAGE_KEY_HISTORY = 'barney-ai-history';

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
    it('returns [] when localStorage is empty', () => {
      expect(loadHistory()).toEqual([]);
    });

    it('validates and returns saved messages', () => {
      const msgs = [makeMessage({ id: 'm1' }), makeMessage({ id: 'm2' })];
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(msgs));
      const result = loadHistory();
      expect(validateChatHistory).toHaveBeenCalledWith(msgs);
      expect(result).toHaveLength(2);
    });

    it('returns [] and clears on corrupt data', () => {
      localStorage.setItem(STORAGE_KEY_HISTORY, 'not-json-at-all');
      const result = loadHistory();
      expect(result).toEqual([]);
      expect(logError).toHaveBeenCalled();
      expect(localStorage.getItem(STORAGE_KEY_HISTORY)).toBeNull();
    });

    it('clears isStreaming on rehydrated messages and surfaces an interrupted error', () => {
      const msgs = [makeMessage({ id: 'm1', isStreaming: true, content: 'half-streamed' })];
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(msgs));
      const result = loadHistory();
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
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(msgs));
      const result = loadHistory();
      expect(result[0].error).toBe('Interrupted');
      expect(result[0].content).toMatch(/interrupted/i);
      expect(result[0].awaitingConfirmation).toBe(false);
    });

    it('does NOT rewrite tool messages with confirmation-prompt content but no awaitingConfirmation flag', () => {
      const msgs = [makeMessage({
        id: 'm1',
        role: 'tool',
        content: 'Deploy "redis" on micro tier?',
      })];
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(msgs));
      const result = loadHistory();
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
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(msgs));
      const result = loadHistory();
      expect(result[0].toolCalls).toBeUndefined();
    });

    it('leaves normal completed messages untouched', () => {
      const msgs = [
        makeMessage({ id: 'u1', role: 'user', content: 'hi' }),
        makeMessage({ id: 'a1', role: 'assistant', content: 'hello!' }),
      ];
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(msgs));
      const result = loadHistory();
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
    it('filters out streaming messages', () => {
      const msgs = [
        makeMessage({ id: 'm1', isStreaming: false }),
        makeMessage({ id: 'm2', isStreaming: true }),
      ];
      saveHistory(msgs, true);
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY)!);
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
      saveHistory(msgs, true);
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY)!);
      expect(stored[0].content).toBe('[help displayed to user]');
      expect(stored[0].card).toBeUndefined();
      expect(stored[0].toolCalls).toBeUndefined();
    });

    it('removes localStorage key when saveHistory is false', () => {
      localStorage.setItem(STORAGE_KEY_HISTORY, 'some data');
      saveHistory([], false);
      expect(localStorage.getItem(STORAGE_KEY_HISTORY)).toBeNull();
    });
  });

  // ---- clearHistoryStorage ----

  describe('clearHistoryStorage', () => {
    it('removes the history key', () => {
      localStorage.setItem(STORAGE_KEY_HISTORY, 'data');
      clearHistoryStorage();
      expect(localStorage.getItem(STORAGE_KEY_HISTORY)).toBeNull();
    });
  });

  // ---- setupPersistenceSubscriptions ----

  describe('setupPersistenceSubscriptions', () => {
    function createMiniStore() {
      return createStore(() => ({
        settings: { ...defaultSettings },
        messages: [] as ChatMessage[],
        isStreaming: false,
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

    it('fires saveHistory on messages change', () => {
      const miniStore = createMiniStore();
      const unsub = setupPersistenceSubscriptions(miniStore);

      miniStore.setState({ messages: [makeMessage()] });

      const stored = localStorage.getItem(STORAGE_KEY_HISTORY);
      expect(stored).not.toBeNull();

      unsub();
    });

    it('skips history writes while isStreaming is true', () => {
      const miniStore = createMiniStore();
      const unsub = setupPersistenceSubscriptions(miniStore);

      miniStore.setState({ isStreaming: true });
      localStorage.clear();

      // Several message updates during streaming (~60x/s) must not write.
      miniStore.setState({ messages: [makeMessage({ id: 's1' })] });
      miniStore.setState({ messages: [makeMessage({ id: 's1' }), makeMessage({ id: 's2' })] });
      miniStore.setState({
        messages: [makeMessage({ id: 's1' }), makeMessage({ id: 's2' }), makeMessage({ id: 's3' })],
      });

      expect(localStorage.getItem(STORAGE_KEY_HISTORY)).toBeNull();

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
      expect(JSON.parse(stored!)).toHaveLength(1);
      expect(JSON.parse(stored!)[0].id).toBe('a1');

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
