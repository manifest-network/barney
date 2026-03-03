/**
 * AIStoreProvider — thin lifecycle wrapper around the Zustand AI store.
 * Sets up persistence subscriptions, health checks, and confirmation timeouts.
 * Renders children directly (no Context.Provider).
 */

import { useEffect, type ReactNode } from 'react';
import { getAIStore, checkConnection } from '../stores/aiStore';
import { setupPersistenceSubscriptions } from '../stores/aiActions/persistence';
import { AI_HEALTH_CHECK_INTERVAL_MS, AI_CONFIRMATION_TIMEOUT_MS, MS_PER_SECOND, SECONDS_PER_MINUTE } from '../config/constants';
import { logError } from '../utils/errors';

// Re-export types for backward compatibility
export type { ChatMessage, PendingConfirmation, AISettings } from '../stores/aiStore';

export function AIProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const store = getAIStore();

    // Persistence subscriptions (settings + history to localStorage)
    const unsubPersistence = setupPersistenceSubscriptions(store);

    // AI API health check
    checkConnection(store);
    const healthInterval = setInterval(() => checkConnection(store), AI_HEALTH_CHECK_INTERVAL_MS);

    // Confirmation timeout watcher
    let confirmationTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const unsubConfirmation = store.subscribe((state, prev) => {
      if (state.pendingConfirmation === prev.pendingConfirmation) return;

      // Clear old timeout
      if (confirmationTimeoutId) {
        clearTimeout(confirmationTimeoutId);
        confirmationTimeoutId = null;
      }

      if (!state.pendingConfirmation) {
        return;
      }

      const capturedId = state.pendingConfirmation.id;

      confirmationTimeoutId = setTimeout(() => {
        const current = store.getState();
        if (current.pendingConfirmation?.id === capturedId) {
          const { messageId } = current.pendingConfirmation;
          const timeoutMinutes = AI_CONFIRMATION_TIMEOUT_MS / (MS_PER_SECOND * SECONDS_PER_MINUTE);
          const updatedMessages = current.messages.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  content: `Action timed out - confirmation not received within ${timeoutMinutes} minutes.`,
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
