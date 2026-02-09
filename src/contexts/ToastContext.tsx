import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react';
import { ToastContext } from './toastContextValue';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  exiting?: boolean;
}

export interface ToastContextType {
  toasts: Toast[];
  addToast: (type: ToastType, message: string, duration?: number) => void;
  removeToast: (id: string) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
}

/** Default auto-dismiss duration for toasts in milliseconds */
const TOAST_DEFAULT_DURATION_MS = 5000;
/** Duration of the exit animation in milliseconds */
const TOAST_EXIT_MS = 300;
/** Maximum visible (non-exiting) toasts */
const MAX_VISIBLE_TOASTS = 5;

let toastIdCounter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const exitTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Cleanup exit timeouts on unmount
  useEffect(() => {
    const timeouts = exitTimeoutsRef.current;
    return () => {
      timeouts.forEach((t) => clearTimeout(t));
      timeouts.clear();
    };
  }, []);

  // Mark toast as exiting (plays animation), then remove from DOM
  const removeToast = useCallback((id: string) => {
    setToasts((prev) => {
      // Already exiting or doesn't exist — no-op
      if (!prev.some((t) => t.id === id && !t.exiting)) return prev;
      return prev.map((t) => (t.id === id ? { ...t, exiting: true } : t));
    });
    const timeout = setTimeout(() => {
      exitTimeoutsRef.current.delete(timeout);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_EXIT_MS);
    exitTimeoutsRef.current.add(timeout);
  }, []);

  const addToast = useCallback((type: ToastType, message: string, duration = TOAST_DEFAULT_DURATION_MS) => {
    const id = `toast-${++toastIdCounter}-${Date.now()}`;
    setToasts((prev) => [...prev, { id, type, message, duration }]);
    return id;
  }, []);

  // Evict oldest when over limit
  useEffect(() => {
    const active = toasts.filter((t) => !t.exiting);
    if (active.length > MAX_VISIBLE_TOASTS) {
      removeToast(active[0].id);
    }
  }, [toasts, removeToast]);

  const success = useCallback((message: string, duration?: number) => {
    addToast('success', message, duration);
  }, [addToast]);

  const error = useCallback((message: string, duration?: number) => {
    addToast('error', message, duration);
  }, [addToast]);

  const warning = useCallback((message: string, duration?: number) => {
    addToast('warning', message, duration);
  }, [addToast]);

  const info = useCallback((message: string, duration?: number) => {
    addToast('info', message, duration);
  }, [addToast]);

  const value = useMemo(
    () => ({ toasts, addToast, removeToast, success, error, warning, info }),
    [toasts, addToast, removeToast, success, error, warning, info]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
    </ToastContext.Provider>
  );
}
