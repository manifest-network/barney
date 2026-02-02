/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { AUTO_REFRESH_INTERVAL_MS } from '../config/constants';
import { logError } from '../utils/errors';

/**
 * Context value for the auto-refresh system.
 */
interface AutoRefreshContextValue {
  /** Whether auto-refresh is currently enabled */
  isEnabled: boolean;
  /** Toggle auto-refresh on/off */
  toggle: () => void;
  /** Whether a refresh is currently in progress */
  isRefreshing: boolean;
  /** Timestamp of the last successful refresh */
  lastRefresh: Date | null;
  /** Manually trigger a refresh */
  refresh: () => void;
  /** Register a fetch function for the current tab */
  registerFetchFn: (fn: () => Promise<void>) => void;
  /** Unregister the current fetch function */
  unregisterFetchFn: () => void;
}

const AutoRefreshContext = createContext<AutoRefreshContextValue | null>(null);

/**
 * Provider component for the auto-refresh system.
 *
 * This context provides centralized auto-refresh functionality for all tabs.
 * Each tab can register its fetch function, and the context will automatically
 * call it at the configured interval.
 *
 * Key behaviors:
 * - Only one fetch function can be registered at a time (last one wins)
 * - Polling pauses when the browser tab is hidden and resumes when visible
 * - Manual refresh is always available via the `refresh` function
 * - Toggle allows users to enable/disable auto-refresh globally
 *
 * Usage in tabs:
 * ```tsx
 * const { registerFetchFn, unregisterFetchFn } = useAutoRefreshContext();
 *
 * useEffect(() => {
 *   registerFetchFn(fetchData);
 *   return () => unregisterFetchFn();
 * }, [fetchData, registerFetchFn, unregisterFetchFn]);
 * ```
 */
export function AutoRefreshProvider({ children }: { children: ReactNode }) {
  const [isEnabled, setIsEnabled] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchFnRef = useRef<(() => Promise<void>) | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);

  const doFetch = useCallback(async () => {
    if (!isMountedRef.current || !fetchFnRef.current) return;

    setIsRefreshing(true);
    try {
      await fetchFnRef.current();
      if (isMountedRef.current) {
        setLastRefresh(new Date());
      }
    } catch (error) {
      // Log the error; individual tabs may also handle errors in their fetch functions
      logError('AutoRefreshContext.doFetch', error);
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
    intervalRef.current = setInterval(doFetch, AUTO_REFRESH_INTERVAL_MS);
  }, [doFetch]);

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
      } else if (isEnabled && fetchFnRef.current) {
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
    if (isEnabled && fetchFnRef.current && !document.hidden) {
      startPolling();
    } else {
      stopPolling();
    }

    return stopPolling;
  }, [isEnabled, startPolling, stopPolling]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  const toggle = useCallback(() => setIsEnabled((prev) => !prev), []);

  const registerFetchFn = useCallback((fn: () => Promise<void>) => {
    fetchFnRef.current = fn;
    // Immediate fetch when registering
    if (isEnabled && !document.hidden) {
      doFetch();
      startPolling();
    }
  }, [isEnabled, doFetch, startPolling]);

  const unregisterFetchFn = useCallback(() => {
    fetchFnRef.current = null;
    stopPolling();
  }, [stopPolling]);

  return (
    <AutoRefreshContext.Provider
      value={{
        isEnabled,
        toggle,
        isRefreshing,
        lastRefresh,
        refresh: doFetch,
        registerFetchFn,
        unregisterFetchFn,
      }}
    >
      {children}
    </AutoRefreshContext.Provider>
  );
}

export function useAutoRefreshContext() {
  const context = useContext(AutoRefreshContext);
  if (!context) {
    throw new Error('useAutoRefreshContext must be used within AutoRefreshProvider');
  }
  return context;
}

