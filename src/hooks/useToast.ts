import { useContext } from 'react';
import { ToastContext } from '../contexts/toastContextValue';
import type { ToastContextType } from '../contexts/ToastContext';

export function useToast(): ToastContextType {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
