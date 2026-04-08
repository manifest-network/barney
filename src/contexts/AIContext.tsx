/**
 * AIProvider — owns the AI Zustand store and exposes it via React Context.
 *
 * Follows the official zustand pattern for vanilla stores in React:
 *   https://zustand.docs.pmnd.rs/guides/initialize-state-with-props
 *
 * The store is created exactly once per Provider mount via `useState`'s lazy
 * initializer, so the reference is stable across renders and survives React 18
 * StrictMode's simulated unmount/remount. Consumers read it through Context, so
 * there is no module-level singleton to orphan when effects clean up.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { createAIStore, checkConnection } from '../stores/aiStore';
import { AIStoreContext } from './aiStoreContext';
import { setupPersistenceSubscriptions } from '../stores/aiActions/persistence';
import { useVisibilityPolling } from '../hooks/useVisibilityPolling';
import { AI_HEALTH_CHECK_INTERVAL_MS, AI_HEALTH_CHECK_MAX_BACKOFF, AI_CONFIRMATION_TIMEOUT_MS, MS_PER_SECOND, SECONDS_PER_MINUTE } from '../config/constants';
import { logError } from '../utils/errors';

// Re-export types for backward compatibility
export type { ChatMessage, PendingConfirmation, AISettings } from '../stores/aiStore';

export function AIProvider({ children }: { children: ReactNode }) {
  // Lazy initializer — runs exactly once per Provider mount. React preserves
  // the value across StrictMode's simulated unmount/remount, so the store
  // identity is stable.
  const [store] = useState(() => createAIStore());

  // Health check with visibility-aware polling + exponential backoff.
  useVisibilityPolling(
    async () => {
      await checkConnection(store);
      return store.getState().isConnected;
    },
    AI_HEALTH_CHECK_INTERVAL_MS,
    { backoff: true, maxBackoffMultiplier: AI_HEALTH_CHECK_MAX_BACKOFF, context: 'AIProvider.healthCheck' },
  );

  // Persistence subscriptions + confirmation timeout
  useEffect(() => {
    // Persistence subscriptions (settings + history to localStorage)
    const unsubPersistence = setupPersistenceSubscriptions(store);

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
      unsubConfirmation();
      if (confirmationTimeoutId) clearTimeout(confirmationTimeoutId);
      store.getState().destroy();
    };
  }, [store]);

  return <AIStoreContext.Provider value={store}>{children}</AIStoreContext.Provider>;
}
