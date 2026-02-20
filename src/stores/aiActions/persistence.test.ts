import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../ai/validation', () => ({
  validateSettings: vi.fn((data: unknown) => data),
  validateChatHistory: vi.fn((data: unknown) => (Array.isArray(data) ? data : [])),
  validateEndpointUrl: vi.fn((url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return null;
  }),
}));

vi.mock('../../config/runtimeConfig', () => ({
  runtimeConfig: {
    PUBLIC_OLLAMA_URL: 'http://localhost:11434',
    PUBLIC_OLLAMA_MODEL: 'llama3.2',
  },
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
      const saved = { ollamaEndpoint: 'http://custom:1234', model: 'qwen2.5', saveHistory: false, enableThinking: true };
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(saved));
      const result = loadSettings();
      expect(validateSettings).toHaveBeenCalledWith(saved);
      expect(result.model).toBe('qwen2.5');
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
  });

  // ---- saveSettings ----

  describe('saveSettings', () => {
    it('writes JSON to localStorage', () => {
      const settings: AISettings = { ...defaultSettings, model: 'custom-model' };
      saveSettings(settings);
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_SETTINGS)!);
      expect(stored.model).toBe('custom-model');
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
      })) as unknown as StoreApi<AIStore>;
    }

    it('fires saveSettings on settings change', () => {
      const miniStore = createMiniStore();
      const unsub = setupPersistenceSubscriptions(miniStore);

      miniStore.setState({ settings: { ...defaultSettings, model: 'new-model' } });

      const stored = localStorage.getItem(STORAGE_KEY_SETTINGS);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).model).toBe('new-model');

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

    it('unsubscribe prevents further saves', () => {
      const miniStore = createMiniStore();
      const unsub = setupPersistenceSubscriptions(miniStore);
      unsub();

      localStorage.clear();
      miniStore.setState({ settings: { ...defaultSettings, model: 'after-unsub' } });

      expect(localStorage.getItem(STORAGE_KEY_SETTINGS)).toBeNull();
    });
  });
});
