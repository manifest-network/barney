import { useEffect } from 'react';
import { useAutoRefreshContext } from '../contexts/AutoRefreshContext';

/**
 * Hook for registering a tab's fetch function with the auto-refresh system.
 *
 * This hook encapsulates the common pattern of registering a fetch function
 * when a tab mounts and unregistering when it unmounts. The registered function
 * will be called immediately on registration and then at the auto-refresh interval.
 *
 * @param fetchFn - The function to call for fetching tab data
 * @param enabled - Whether auto-refresh should be enabled (default: true)
 *
 * @example
 * ```tsx
 * const fetchData = useCallback(async () => {
 *   const data = await fetchSomeData();
 *   setData(data);
 * }, []);
 *
 * useAutoRefreshTab(fetchData, isConnected && !!address);
 * ```
 */
export function useAutoRefreshTab(fetchFn: () => Promise<void>, enabled: boolean = true): void {
  const { registerFetchFn, unregisterFetchFn } = useAutoRefreshContext();

  useEffect(() => {
    if (enabled) {
      registerFetchFn(fetchFn);
    }
    return () => unregisterFetchFn();
  }, [enabled, fetchFn, registerFetchFn, unregisterFetchFn]);
}
