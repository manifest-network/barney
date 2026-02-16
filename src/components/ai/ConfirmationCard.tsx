import { memo, useMemo, useRef, useState, useCallback } from 'react';
import { AlertTriangle, Check, X, Paperclip, Copy, CheckCheck, Eye, EyeOff } from 'lucide-react';
import type { PendingAction } from '../../ai/toolExecutor';
import { formatFileSize } from '../../utils/format';
import { logError } from '../../utils/errors';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { ManifestEditor } from './ManifestEditor';
import { parseEditableManifest, serializeManifest, type ManifestFields } from './manifestEditorUtils';

function parseManifestEnv(payload: PendingAction['payload']): Record<string, string> | null {
  if (!payload?.bytes) return null;
  try {
    const text = new TextDecoder().decode(payload.bytes);
    const manifest = JSON.parse(text) as { env?: Record<string, string> };
    if (manifest.env && Object.keys(manifest.env).length > 0) return manifest.env;
  } catch (error) {
    logError('ConfirmationCard.parseManifestEnv', error);
  }
  return null;
}

interface StackServiceSummary {
  image: string;
  ports: string[];
  envCount: number;
}

function parseStackManifest(action: PendingAction): Record<string, StackServiceSummary> | null {
  const json = action.args._generatedManifest;
  if (typeof json !== 'string') return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed.services || typeof parsed.services !== 'object' || Array.isArray(parsed.services)) return null;
    const result: Record<string, StackServiceSummary> = {};
    for (const [name, svc] of Object.entries(parsed.services as Record<string, Record<string, unknown>>)) {
      if (!svc || typeof svc !== 'object') continue;
      result[name] = {
        image: (svc.image as string) || 'unknown',
        ports: svc.ports ? Object.keys(svc.ports as Record<string, unknown>) : [],
        envCount: svc.env ? Object.keys(svc.env as Record<string, unknown>).length : 0,
      };
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch (error) {
    logError('ConfirmationCard.parseStackManifest', error);
    return null;
  }
}

/** Internal args that should not be shown in the confirmation parameters. */
const INTERNAL_ARGS = new Set(['_generatedManifest', '_serviceNames', '_isStack']);

const SENSITIVE_PATTERN = /password|secret|token|key|credential/i;

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

function SensitiveValue({ envKey, value }: { envKey: string; value: string }) {
  const isSensitive = SENSITIVE_PATTERN.test(envKey);
  const [revealed, setRevealed] = useState(!isSensitive);

  return (
    <span className="flex items-center gap-1">
      <code className="font-mono text-xs text-primary">{revealed ? value : '\u2022'.repeat(12)}</code>
      {isSensitive && (
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          className="btn-icon"
          aria-label={revealed ? 'Hide value' : 'Reveal value'}
          title={revealed ? 'Hide' : 'Reveal'}
        >
          {revealed ? <EyeOff className="w-3.5 h-3.5 text-muted" /> : <Eye className="w-3.5 h-3.5 text-muted" />}
        </button>
      )}
      <CopyButton value={value} />
    </span>
  );
}

interface ConfirmationCardProps {
  action: PendingAction;
  onConfirm: (editedManifestJson?: string) => void;
  onCancel: () => void;
  isExecuting?: boolean;
}

export const ConfirmationCard = memo(function ConfirmationCard({ action, onConfirm, onCancel, isExecuting }: ConfirmationCardProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const trapRef = useFocusTrap(true, {
    onEscape: () => { if (!isExecuting) onCancel(); },
    initialFocusRef: cancelRef,
  });

  const initialManifest = useMemo(() => parseEditableManifest(action), [action]);
  const [editedManifest, setEditedManifest] = useState<ManifestFields | null>(initialManifest);
  const isEditable = initialManifest !== null;

  const manifestEnv = useMemo(() => {
    if (isEditable) return null; // ManifestEditor handles env display for editable manifests
    return parseManifestEnv(action.payload);
  }, [action.payload, isEditable]);

  const stackServices = useMemo(() => {
    if (isEditable) return null;
    return parseStackManifest(action);
  }, [action, isEditable]);

  const handleConfirm = useCallback(() => {
    if (editedManifest) {
      onConfirm(serializeManifest(editedManifest));
    } else {
      onConfirm();
    }
  }, [editedManifest, onConfirm]);

  // Filter out internal args for display
  const displayArgs = useMemo(() => {
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(action.args)) {
      if (!INTERNAL_ARGS.has(k)) {
        filtered[k] = v;
      }
    }
    return filtered;
  }, [action.args]);

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

        {isEditable && editedManifest ? (
          <div className="confirmation-details">
            <ManifestEditor manifest={editedManifest} onChange={setEditedManifest} />
          </div>
        ) : (
          <>
            {stackServices ? (
              <div className="confirmation-details">
                <p className="confirmation-details-title">Services ({Object.keys(stackServices).length}):</p>
                <div className="confirmation-payload">
                  {Object.entries(stackServices).map(([name, svc]) => (
                    <div key={name} className="flex items-start gap-2 text-sm py-1">
                      <code className="font-mono text-xs text-primary font-semibold whitespace-nowrap">{name}</code>
                      <div className="text-dim text-xs">
                        <span>{svc.image}</span>
                        {svc.ports.length > 0 && (
                          <span className="text-muted"> · {svc.ports.join(', ')}</span>
                        )}
                        {svc.envCount > 0 && (
                          <span className="text-muted"> · {svc.envCount} env var{svc.envCount !== 1 ? 's' : ''}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : action.args.entries && Array.isArray(action.args.entries) && action.args.entries.length > 1 ? (
              <div className="confirmation-details">
                <p className="confirmation-details-title">Apps to deploy:</p>
                <ul className="confirmation-batch-list">
                  {(action.args.entries as Array<{ app_name: string; size?: string }>).map((entry) => (
                    <li key={entry.app_name}>{entry.app_name} ({entry.size || 'micro'})</li>
                  ))}
                </ul>
              </div>
            ) : Object.keys(displayArgs).length > 0 && (
              <div className="confirmation-details">
                <p className="confirmation-details-title">Parameters:</p>
                <pre className="confirmation-args" tabIndex={0} aria-label="Transaction parameters">
                  {JSON.stringify(displayArgs, null, 2)}
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
                <p className="confirmation-details-title">Environment Variables:</p>
                <div className="confirmation-payload">
                  {Object.entries(manifestEnv).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-2 text-sm">
                      <span className="font-mono text-xs text-dim">{key}</span>
                      <SensitiveValue envKey={key} value={value} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
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
          onClick={handleConfirm}
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
