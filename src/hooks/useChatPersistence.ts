/**
 * Chat persistence hook — manages settings and history state with localStorage backing.
 */

import { useState, useCallback, useEffect } from 'react';
import {
  validateSettings,
  validateChatHistory,
  validateEndpointUrl,
  type AISettings,
} from '../ai/validation';
import { logError } from '../utils/errors';
import type { ChatMessage } from '../contexts/aiTypes';

const STORAGE_KEY_SETTINGS = 'barney-ai-settings';
const STORAGE_KEY_HISTORY = 'barney-ai-history';

// Validate environment-provided defaults
const envEndpoint = validateEndpointUrl(import.meta.env.PUBLIC_OLLAMA_URL || '');
const defaultSettings: AISettings = {
  ollamaEndpoint: envEndpoint || 'http://localhost:11434',
  model: import.meta.env.PUBLIC_OLLAMA_MODEL || 'llama3.2',
  saveHistory: true,
  enableThinking: false,
};

// Lazy initializers — run synchronously before first render so state is hydrated immediately.
// This avoids the effect-based load/save race where save effects clobber localStorage
// with empty state before the load effect's setState has taken effect.
function loadSettings(): AISettings {
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

function loadHistory(): ChatMessage[] {
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

export function useChatPersistence() {
  const [settings, setSettings] = useState<AISettings>(loadSettings);
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory);

  // Save settings to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
    } catch (error) {
      logError('AIContext.saveSettings', error);
    }
  }, [settings]);

  // Save history to localStorage (if enabled)
  useEffect(() => {
    if (settings.saveHistory) {
      try {
        // Only save non-streaming messages; strip card data to avoid persisting large logs
        const toSave = messages
          .filter((m) => !m.isStreaming)
          .map(({ card, ...rest }) => rest);
        localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(toSave));
      } catch (error) {
        logError('AIContext.saveHistory', error);
      }
    }
  }, [messages, settings.saveHistory]);

  const updateSettings = useCallback((newSettings: Partial<AISettings>) => {
    setSettings((prev) => {
      const updated = { ...prev };

      // Validate endpoint URL if provided
      if (newSettings.ollamaEndpoint !== undefined) {
        const validatedUrl = validateEndpointUrl(newSettings.ollamaEndpoint);
        if (validatedUrl) {
          updated.ollamaEndpoint = validatedUrl;
        }
        // If invalid, keep the previous value
      }

      // Validate and copy other settings
      if (typeof newSettings.model === 'string' && newSettings.model.length > 0) {
        updated.model = newSettings.model;
      }
      if (typeof newSettings.saveHistory === 'boolean') {
        updated.saveHistory = newSettings.saveHistory;
      }
      if (typeof newSettings.enableThinking === 'boolean') {
        updated.enableThinking = newSettings.enableThinking;
      }

      return updated;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY_HISTORY);
  }, []);

  return { settings, updateSettings, messages, setMessages, clearHistory };
}

export type { AISettings };
