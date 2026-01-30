/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';

const REFRESH_INTERVAL = 10000; // 10 seconds for all pages

interface AutoRefreshContextValue {
  isEnabled: boolean;
  toggle: () => void;
  isRefreshing: boolean;
  lastRefresh: Date | null;
  refresh: () => void;
  registerFetchFn: (fn: () => Promise<void>) => void;
  unregisterFetchFn: () => void;
}

const AutoRefreshContext = createContext<AutoRefreshContextValue | null>(null);

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
    } catch {
      // Errors are handled by individual tabs
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
    intervalRef.current = setInterval(doFetch, REFRESH_INTERVAL);
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

