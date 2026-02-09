import { useState, useEffect, useRef, useCallback } from 'react';
import { X, CheckCircle, XCircle, AlertTriangle, Info } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import type { Toast, ToastType } from '../../contexts/ToastContext';
import { cn } from '../../utils/cn';

const iconMap: Record<ToastType, React.ElementType> = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const toastStyles: Record<ToastType, string> = {
  success: 'toast-success',
  error: 'toast-error',
  warning: 'toast-warning',
  info: 'toast-info',
};

const toastLabels: Record<ToastType, string> = {
  success: 'Success',
  error: 'Error',
  warning: 'Warning',
  info: 'Information',
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const Icon = iconMap[toast.type];
  const ariaLive = toast.type === 'error' ? 'assertive' as const : 'polite' as const;
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(toast.duration || 0);
  const startRef = useRef(0);

  const dismiss = useCallback(() => onDismiss(toast.id), [onDismiss, toast.id]);

  // Auto-dismiss timer with pause support
  useEffect(() => {
    if (paused || toast.exiting || !toast.duration || remainingRef.current <= 0) return;

    startRef.current = Date.now();
    const timer = setTimeout(dismiss, remainingRef.current);
    return () => {
      clearTimeout(timer);
      if (startRef.current > 0) {
        remainingRef.current -= Date.now() - startRef.current;
        startRef.current = 0;
      }
    };
  }, [paused, toast.exiting, toast.duration, dismiss]);

  return (
    <div
      className={cn('toast', toastStyles[toast.type], toast.exiting && 'toast--exit')}
      role="status"
      aria-live={ariaLive}
      aria-atomic="true"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <Icon className="toast-icon" size={20} aria-hidden="true" />
      <span className="toast-message">
        <span className="sr-only">{toastLabels[toast.type]}: </span>
        {toast.message}
      </span>
      <button
        type="button"
        onClick={dismiss}
        className="toast-close"
        aria-label={`Dismiss ${toastLabels[toast.type].toLowerCase()} notification`}
      >
        <X size={16} aria-hidden="true" />
      </button>
      {toast.duration != null && toast.duration > 0 && (
        <div
          className={cn('toast-progress', paused && 'toast-progress--paused')}
          style={{ '--toast-duration': `${toast.duration}ms` } as React.CSSProperties}
        />
      )}
    </div>
  );
}

export function ToastContainer() {
  const { toasts, removeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      className="toast-container"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={removeToast} />
      ))}
    </div>
  );
}
