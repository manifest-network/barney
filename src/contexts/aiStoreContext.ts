/**
 * React Context + selector hook for the AI Zustand store.
 *
 * Split out from `AIContext.tsx` so that the hook lives in a non-component
 * file (eslint-plugin-react-refresh requires component files to export only
 * components).
 *
 * Follows the official zustand vanilla-store-in-context pattern:
 *   https://zustand.docs.pmnd.rs/guides/initialize-state-with-props
 */

import { createContext, useContext } from 'react';
import { useStore, type StoreApi } from 'zustand';
import type { AIStore } from '../stores/aiStore';

export const AIStoreContext = createContext<StoreApi<AIStore> | null>(null);

/**
 * Selector hook for the AI store. Must be used inside `<AIProvider>`.
 *
 * Mirrors the shape of zustand's `create()` hook so call sites read like
 * `useAIStore((s) => s.field)`.
 */
export function useAIStore<T>(selector: (state: AIStore) => T): T {
  const store = useContext(AIStoreContext);
  if (!store) {
    throw new Error('useAIStore must be used inside <AIProvider>');
  }
  return useStore(store, selector);
}
