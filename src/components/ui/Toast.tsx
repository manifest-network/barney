import { X, CheckCircle, XCircle, AlertTriangle, Info } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import type { ToastType } from '../../contexts/ToastContext';
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

export function ToastContainer() {
  const { toasts, removeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      className="toast-container"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((toast) => {
        const Icon = iconMap[toast.type];
        // Use assertive for errors, polite for others
        const ariaLive = toast.type === 'error' ? 'assertive' : 'polite';

        return (
          <div
            key={toast.id}
            className={cn('toast', toastStyles[toast.type])}
            role="status"
            aria-live={ariaLive}
            aria-atomic="true"
          >
            <Icon className="toast-icon" size={20} aria-hidden="true" />
            <span className="toast-message">
              <span className="sr-only">{toastLabels[toast.type]}: </span>
              {toast.message}
            </span>
            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              className="toast-close"
              aria-label={`Dismiss ${toastLabels[toast.type].toLowerCase()} notification`}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
