/**
 * useRegistryApps — subscribe to the wallet's app registry.
 *
 * Returns the apps array, kept in sync via `subscribeToRegistry` (in-tab) and
 * a cached snapshot. Used by long-lived layout components that need a live
 * app list — e.g. MainLayout's mount of `useDnsStatusPolling`, which lives
 * outside the sidebar's ErrorBoundary so polling survives a sidebar render
 * error.
 *
 * Implementation: `useSyncExternalStore` is the canonical React 19 pattern
 * for subscribing to an external store like our localStorage-backed registry.
 * It avoids the `set-state-in-effect` lint rule that a useState+useEffect
 * port would trip.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { getApps, subscribeToRegistry, type AppEntry } from '../registry/appRegistry';

const EMPTY: AppEntry[] = [];

export function useRegistryApps(address: string | undefined): AppEntry[] {
  // Cache the most recent snapshot per address so repeated getSnapshot calls
  // return referential equality — required by useSyncExternalStore.
  const cacheRef = useRef<{ address: string | undefined; apps: AppEntry[] }>({ address: undefined, apps: EMPTY });

  const subscribe = useCallback(
    (notify: () => void) => {
      if (!address) return () => undefined;
      return subscribeToRegistry((mutated) => {
        if (mutated === address) {
          // Invalidate cache so next getSnapshot reads fresh apps.
          cacheRef.current = { address, apps: getApps(address) };
          notify();
        }
      });
    },
    [address],
  );

  const getSnapshot = useCallback(() => {
    if (!address) return EMPTY;
    if (cacheRef.current.address !== address) {
      cacheRef.current = { address, apps: getApps(address) };
    }
    return cacheRef.current.apps;
  }, [address]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
