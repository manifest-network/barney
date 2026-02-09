import { memo, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, X, Paperclip, Copy, CheckCheck } from 'lucide-react';
import type { PendingAction } from '../../ai/toolExecutor';
import { formatFileSize } from '../../utils/format';
import { logError } from '../../utils/errors';
import { useFocusTrap } from '../../hooks/useFocusTrap';

function parseManifestEnv(payload: PendingAction['payload']): Record<string, string> | null {
  if (!payload?.bytes) return null;
  try {
    const text = new TextDecoder().decode(payload.bytes);
    const manifest = JSON.parse(text) as { env?: Record<string, string> };
    if (manifest.env && Object.keys(manifest.env).length > 0) return manifest.env;
  } catch { /* ignore parse errors */ }
  return null;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch((err) => logError('CopyButton', err));
  };
  return (
    <button type="button" onClick={handleCopy} className="btn-icon" aria-label="Copy to clipboard" title="Copy">
      {copied ? <CheckCheck className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5 text-muted" />}
    </button>
  );
}

interface ConfirmationCardProps {
  action: PendingAction;
  onConfirm: () => void;
  onCancel: () => void;
  isExecuting?: boolean;
}

export const ConfirmationCard = memo(function ConfirmationCard({ action, onConfirm, onCancel, isExecuting }: ConfirmationCardProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const trapRef = useFocusTrap(true, {
    onEscape: () => { if (!isExecuting) onCancel(); },
    initialFocusRef: cancelRef,
  });
  const manifestEnv = useMemo(() => parseManifestEnv(action.payload), [action.payload]);

  return (
    <div
      ref={trapRef}
      className="confirmation-card"
      role="alertdialog"
      aria-labelledby="confirmation-title"
      aria-describedby="confirmation-description"
      tabIndex={-1}
    >
      <div className="confirmation-header">
        <AlertTriangle className="w-5 h-5 text-warning" />
        <span id="confirmation-title">Transaction Confirmation Required</span>
      </div>
      <div className="confirmation-body">
        <p id="confirmation-description" className="confirmation-description">{action.description}</p>
        {action.args.entries && Array.isArray(action.args.entries) && action.args.entries.length > 1 ? (
          <div className="confirmation-details">
            <p className="confirmation-details-title">Apps to deploy:</p>
            <ul className="confirmation-batch-list">
              {(action.args.entries as Array<{ app_name: string; size?: string }>).map((entry) => (
                <li key={entry.app_name}>{entry.app_name} ({entry.size || 'micro'})</li>
              ))}
            </ul>
          </div>
        ) : Object.keys(action.args).length > 0 && (
          <div className="confirmation-details">
            <p className="confirmation-details-title">Parameters:</p>
            <pre className="confirmation-args" tabIndex={0} aria-label="Transaction parameters">
              {JSON.stringify(action.args, null, 2)}
            </pre>
          </div>
        )}
        {action.payload && (
          <div className="confirmation-details">
            <p className="confirmation-details-title">Attached Payload:</p>
            <div className="confirmation-payload">
              <div className="flex items-center gap-1.5 text-sm text-primary">
                <Paperclip className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{action.payload.filename || 'payload'}</span>
                <span className="text-muted">{formatFileSize(action.payload.size)}</span>
              </div>
              <div className="mt-1 font-mono text-xs text-dim break-all">
                SHA-256: {action.payload.hash.slice(0, 16)}...
              </div>
            </div>
          </div>
        )}
        {manifestEnv && (
          <div className="confirmation-details">
            <p className="confirmation-details-title">Generated Credentials:</p>
            <div className="confirmation-payload">
              {Object.entries(manifestEnv).map(([key, value]) => (
                <div key={key} className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-mono text-xs text-dim">{key}</span>
                  <span className="flex items-center gap-1">
                    <code className="font-mono text-xs text-primary">{value}</code>
                    <CopyButton value={value} />
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="confirmation-actions">
        <button
          ref={cancelRef}
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
