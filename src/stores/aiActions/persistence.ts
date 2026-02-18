/**
 * Persistence actions — load/save settings & history from/to localStorage.
 */

import {
  validateSettings,
  validateChatHistory,
  validateEndpointUrl,
  type AISettings,
} from '../../ai/validation';
import { runtimeConfig } from '../../config/runtimeConfig';
import { logError } from '../../utils/errors';
import type { ChatMessage } from '../../contexts/aiTypes';
import type { StoreApi } from 'zustand';
import type { AIStore } from '../aiStore';

const STORAGE_KEY_SETTINGS = 'barney-ai-settings';
const STORAGE_KEY_HISTORY = 'barney-ai-history';

const envEndpoint = validateEndpointUrl(runtimeConfig.PUBLIC_OLLAMA_URL);

export const defaultSettings: AISettings = {
  ollamaEndpoint: envEndpoint || 'http://localhost:11434',
  model: runtimeConfig.PUBLIC_OLLAMA_MODEL,
  saveHistory: true,
  enableThinking: false,
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
      return validateChatHistory(JSON.parse(saved)) as ChatMessage[];
    }
  } catch (error) {
    logError('AIContext.loadHistory', error);
    localStorage.removeItem(STORAGE_KEY_HISTORY);
  }
  return [];
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
      const toSave = messages
        .filter((m) => !m.isStreaming)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Intentionally stripping card/toolCalls from persisted messages
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
