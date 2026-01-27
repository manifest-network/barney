import { useEffect, useRef, useState, useCallback } from 'react';

export interface UseAutoRefreshOptions {
  /** Polling interval in milliseconds */
  interval: number;
  /** Whether auto-refresh is enabled */
  enabled?: boolean;
  /** Fetch immediately on mount */
  immediate?: boolean;
  /** Callback when fetch fails */
  onError?: (error: Error) => void;
}

export interface UseAutoRefreshReturn {
  /** Whether auto-refresh is currently enabled */
  isEnabled: boolean;
  /** Toggle auto-refresh on/off */
  toggle: () => void;
  /** Enable auto-refresh */
  enable: () => void;
  /** Disable auto-refresh */
  disable: () => void;
  /** Manually trigger a refresh */
  refresh: () => void;
  /** Whether a refresh is currently in progress */
  isRefreshing: boolean;
  /** Last refresh timestamp */
  lastRefresh: Date | null;
}

/**
 * Hook for auto-refreshing data with visibility awareness.
 * Stops polling when the page is hidden and resumes when visible.
 *
 * @param fetchFn - Async function to fetch data
 * @param options - Configuration options
 */
export function useAutoRefresh(
  fetchFn: () => Promise<void>,
  options: UseAutoRefreshOptions
): UseAutoRefreshReturn {
  const { interval, enabled = true, immediate = true, onError } = options;

  const [isEnabled, setIsEnabled] = useState(enabled);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchFnRef = useRef(fetchFn);
  const isMountedRef = useRef(true);
  const prevEnabledRef = useRef(enabled);
  const hasInitialFetchRef = useRef(false);

  // Keep fetchFn ref updated
  useEffect(() => {
    fetchFnRef.current = fetchFn;
  }, [fetchFn]);

  const doFetch = useCallback(async () => {
    if (!isMountedRef.current) return;

    setIsRefreshing(true);
    try {
      await fetchFnRef.current();
      if (isMountedRef.current) {
        setLastRefresh(new Date());
      }
    } catch (err) {
      if (isMountedRef.current && onError) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      if (isMountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [onError]);

  const startPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    intervalRef.current = setInterval(doFetch, interval);
  }, [doFetch, interval]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Handle visibility change
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else if (isEnabled) {
        // Fetch immediately when becoming visible, then start polling
        doFetch();
        startPolling();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isEnabled, doFetch, startPolling, stopPolling]);

  // Start/stop polling based on enabled state
  useEffect(() => {
    if (isEnabled && !document.hidden) {
      startPolling();
    } else {
      stopPolling();
    }

    return stopPolling;
  }, [isEnabled, startPolling, stopPolling]);

  // Sync isEnabled with enabled prop and fetch when enabled becomes true
  useEffect(() => {
    const wasEnabled = prevEnabledRef.current;
    prevEnabledRef.current = enabled;

    // Sync internal state with prop
    setIsEnabled(enabled);

    // Fetch when enabled transitions from false to true (e.g., wallet connected)
    if (enabled && !wasEnabled && !document.hidden) {
      doFetch();
      hasInitialFetchRef.current = true;
    }
  }, [enabled, doFetch]);

  // Initial fetch (only if enabled from the start)
  useEffect(() => {
    if (immediate && enabled && !hasInitialFetchRef.current) {
      doFetch();
      hasInitialFetchRef.current = true;
    }
  }, [immediate, enabled, doFetch]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  const toggle = useCallback(() => setIsEnabled((prev) => !prev), []);
  const enable = useCallback(() => setIsEnabled(true), []);
  const disable = useCallback(() => setIsEnabled(false), []);

  return {
    isEnabled,
    toggle,
    enable,
    disable,
    refresh: doFetch,
    isRefreshing,
    lastRefresh,
  };
}
