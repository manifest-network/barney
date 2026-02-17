/**
 * AIStoreProvider — thin lifecycle wrapper around the Zustand AI store.
 * Sets up persistence subscriptions, health checks, confirmation timeouts,
 * and initial model fetch. Renders children directly (no Context.Provider).
 */

import { useEffect, type ReactNode } from 'react';
import { getAIStore, checkConnection } from '../stores/aiStore';
import { setupPersistenceSubscriptions } from '../stores/aiActions/persistence';
import { AI_HEALTH_CHECK_INTERVAL_MS } from '../config/constants';
import { AI_CONFIRMATION_TIMEOUT_MS } from '../config/constants';
import { logError } from '../utils/errors';

// Re-export types for backward compatibility
export type { ChatMessage, PendingConfirmation, AISettings } from '../stores/aiStore';
export type { AIContextType } from './aiContextType';

export function AIProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const store = getAIStore();

    // Persistence subscriptions (settings + history to localStorage)
    const unsubPersistence = setupPersistenceSubscriptions(store);

    // Ollama health check
    checkConnection(store);
    const healthInterval = setInterval(() => checkConnection(store), AI_HEALTH_CHECK_INTERVAL_MS);

    // Initial model fetch
    store.getState().refreshModels();

    // Confirmation timeout watcher
    let confirmationTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastConfirmationId: string | null = null;

    const unsubConfirmation = store.subscribe((state, prev) => {
      if (state.pendingConfirmation === prev.pendingConfirmation) return;

      // Clear old timeout
      if (confirmationTimeoutId) {
        clearTimeout(confirmationTimeoutId);
        confirmationTimeoutId = null;
      }

      if (!state.pendingConfirmation) {
        lastConfirmationId = null;
        return;
      }

      lastConfirmationId = state.pendingConfirmation.id;
      const capturedId = lastConfirmationId;

      confirmationTimeoutId = setTimeout(() => {
        const current = store.getState();
        if (current.pendingConfirmation?.id === capturedId) {
          const { messageId } = current.pendingConfirmation;
          const updatedMessages = current.messages.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  content: `Action timed out - confirmation not received within ${AI_CONFIRMATION_TIMEOUT_MS / 60000} minutes.`,
                  isStreaming: false,
                  error: 'timeout',
                }
              : m
          );
          store.setState({
            pendingConfirmation: null,
            pendingPayload: null,
            deployProgress: null,
            messages: updatedMessages,
          });

          logError('AIContext.confirmationTimeout', new Error('Pending confirmation timed out'));
        }
        confirmationTimeoutId = null;
      }, AI_CONFIRMATION_TIMEOUT_MS);
    });

    return () => {
      unsubPersistence();
      clearInterval(healthInterval);
      unsubConfirmation();
      if (confirmationTimeoutId) clearTimeout(confirmationTimeoutId);
      store.getState().destroy();
    };
  }, []);

  return <>{children}</>;
}
