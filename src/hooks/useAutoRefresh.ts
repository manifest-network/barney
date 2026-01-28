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

  const [userEnabled, setUserEnabled] = useState(true);
  const isEnabled = enabled && userEnabled;
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchFnRef = useRef(fetchFn);
  const onErrorRef = useRef(onError);
  const isMountedRef = useRef(true);
  const prevEnabledRef = useRef<boolean | null>(null);

  // Keep refs updated
  useEffect(() => {
    fetchFnRef.current = fetchFn;
  }, [fetchFn]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const doFetch = useCallback(async () => {
    if (!isMountedRef.current) return;

    setIsRefreshing(true);
    try {
      await fetchFnRef.current();
      if (isMountedRef.current) {
        setLastRefresh(new Date());
      }
    } catch (err) {
      if (isMountedRef.current && onErrorRef.current) {
        onErrorRef.current(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      if (isMountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, []);

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

  // Sync with enabled prop and fetch when appropriate
  useEffect(() => {
    const wasEnabled = prevEnabledRef.current;
    const isFirstRun = wasEnabled === null;
    prevEnabledRef.current = enabled;

    if (document.hidden) return;

    // Fetch on first run if immediate and enabled
    if (isFirstRun && immediate && enabled) {
      doFetch();
      return;
    }

    // Reset user toggle and fetch when enabled transitions false → true
    if (enabled && wasEnabled === false) {
      setUserEnabled(true);
      doFetch();
    }
  }, [enabled, immediate, doFetch]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  const toggle = useCallback(() => setUserEnabled((prev) => !prev), []);
  const enable = useCallback(() => setUserEnabled(true), []);
  const disable = useCallback(() => setUserEnabled(false), []);

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
