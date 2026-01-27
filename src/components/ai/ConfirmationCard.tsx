import { memo } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import type { PendingAction } from '../../ai/toolExecutor';

interface ConfirmationCardProps {
  action: PendingAction;
  onConfirm: () => void;
  onCancel: () => void;
  isExecuting?: boolean;
}

export const ConfirmationCard = memo(function ConfirmationCard({ action, onConfirm, onCancel, isExecuting }: ConfirmationCardProps) {
  return (
    <div
      className="confirmation-card"
      role="alertdialog"
      aria-labelledby="confirmation-title"
      aria-describedby="confirmation-description"
    >
      <div className="confirmation-header">
        <AlertTriangle className="w-5 h-5 text-warning" />
        <span id="confirmation-title">Transaction Confirmation Required</span>
      </div>
      <div className="confirmation-body">
        <p id="confirmation-description" className="confirmation-description">{action.description}</p>
        {Object.keys(action.args).length > 0 && (
          <div className="confirmation-details">
            <p className="confirmation-details-title">Parameters:</p>
            <pre className="confirmation-args">
              {JSON.stringify(action.args, null, 2)}
            </pre>
          </div>
        )}
      </div>
      <div className="confirmation-actions">
        <button
          type="button"
          onClick={onCancel}
          disabled={isExecuting}
          className="btn btn-secondary btn-sm"
        >
          <X className="w-4 h-4" />
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isExecuting}
          className="btn btn-success btn-sm"
        >
          <Check className="w-4 h-4" />
          {isExecuting ? 'Executing...' : 'Confirm'}
        </button>
      </div>
    </div>
  );
});
