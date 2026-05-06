import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { AlertTriangle, Check, X, Paperclip, Copy, CheckCheck, Eye, EyeOff } from 'lucide-react';
import { FocusTrap } from 'focus-trap-react';
import type { PendingAction } from '../../ai/toolExecutor';
import { formatFileSize } from '../../utils/format';
import { logError } from '../../utils/errors';
import { findExampleByAppName } from '../../config/exampleApps';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { ManifestEditor } from './ManifestEditor';
import { StackManifestEditor } from './StackManifestEditor';
import { validateAll, validateCustomDomainFormat, apexRecordKindLabel } from '../../utils/customDomainValidation';
import { getDisplaySafeArgs } from '../../ai/tools';
import { CustomDomainBranch, CloudflareProxyHint } from './ConfirmationCardCustomDomain';
import { parseCustomDomainArgs } from './customDomainBranchData';
import {
  parseEditableManifest, serializeManifest,
  parseEditableStackManifest, serializeStackManifest,
  type ManifestFields, type StackManifestFields,
} from './manifestEditorUtils';

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
      const rawPorts = svc.ports;
      const portsRecord = (rawPorts && typeof rawPorts === 'object' && !Array.isArray(rawPorts))
        ? rawPorts as Record<string, Record<string, unknown>>
        : undefined;
      result[name] = {
        image: (svc.image as string) || 'unknown',
        ports: portsRecord
          ? Object.entries(portsRecord).map(([k, v]) => v?.ingress === true ? `${k} (ingress)` : k)
          : [],
        envCount: svc.env ? Object.keys(svc.env as Record<string, unknown>).length : 0,
      };
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch (error) {
    logError('ConfirmationCard.parseStackManifest', error);
    return null;
  }
}



function InlineCopyButton({ value }: { value: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const copied = isCopied(value);
  return (
    <button type="button" onClick={() => copyToClipboard(value)} className="btn-icon" aria-label="Copy to clipboard" title="Copy">
      {copied ? <CheckCheck className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5 text-muted" />}
    </button>
  );
}

function SensitiveValue({ value }: { value: string }) {
  const [revealed, setRevealed] = useState(false);

  return (
    <span className="flex items-center gap-1">
      <code className="font-mono text-xs text-primary">{revealed ? value : '\u2022'.repeat(12)}</code>
      <button
        type="button"
        onClick={() => setRevealed((r) => !r)}
        className="btn-icon"
        aria-label={revealed ? 'Hide value' : 'Reveal value'}
        title={revealed ? 'Hide' : 'Reveal'}
      >
        {revealed ? <EyeOff className="w-3.5 h-3.5 text-muted" /> : <Eye className="w-3.5 h-3.5 text-muted" />}
      </button>
      {revealed && <InlineCopyButton value={value} />}
    </span>
  );
}

import type { ConfirmActionOverrides } from '../../stores/aiActions/confirmAction';

interface ConfirmationCardProps {
  action: PendingAction;
  onConfirm: (overrides?: ConfirmActionOverrides) => void;
  onCancel: () => void;
  isExecuting?: boolean;
}

export const ConfirmationCard = memo(function ConfirmationCard({ action, onConfirm, onCancel, isExecuting }: ConfirmationCardProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const initialManifest = useMemo(() => {
    const manifest = parseEditableManifest(action);
    // Fallback: on updates the stored manifest lacks _notice, so look up the example app by name.
    if (manifest && !manifest.notice && typeof action.args.app_name === 'string') {
      const example = findExampleByAppName(action.args.app_name);
      if (example?.notice) return { ...manifest, notice: example.notice };
    }
    return manifest;
  }, [action]);
  const [editedManifest, setEditedManifest] = useState<ManifestFields | null>(initialManifest);
  const isEditable = initialManifest !== null;

  const initialStack = useMemo(() => parseEditableStackManifest(action), [action]);
  const [editedStack, setEditedStack] = useState<StackManifestFields | null>(initialStack);
  const isStackEditable = initialStack !== null;

  const manifestEnv = useMemo(() => {
    if (isEditable || isStackEditable) return null;
    return parseManifestEnv(action.payload);
  }, [action.payload, isEditable, isStackEditable]);

  const stackServices = useMemo(() => {
    if (isEditable || isStackEditable) return null;
    return parseStackManifest(action);
  }, [action, isEditable, isStackEditable]);

  const customDomainData = useMemo(() => parseCustomDomainArgs(action), [action]);

  // Editable custom domain input on deploy_app ConfirmationCards. Defaults to
  // any AI-prefilled value (`args.customDomain`) so a chat message like
  // "deploy redis with custom domain X" pre-fills the input. Empty input means
  // "no domain attached" — the deploy proceeds without firing the set-domain TX.
  const isDeployApp = action.toolName === 'deploy_app';
  const stackServiceNames = useMemo(() => {
    if (!isDeployApp) return undefined;
    const sn = action.args._serviceNames;
    return Array.isArray(sn) && sn.length > 1 ? (sn as string[]) : undefined;
  }, [isDeployApp, action.args._serviceNames]);

  const initialDomain = typeof action.args.customDomain === 'string' ? action.args.customDomain : '';
  const initialServiceName = typeof action.args.customDomainServiceName === 'string'
    ? action.args.customDomainServiceName
    : '';
  const [editedCustomDomain, setEditedCustomDomain] = useState(initialDomain);
  const [editedCustomDomainServiceName, setEditedCustomDomainServiceName] = useState(initialServiceName);

  // Two layers of validation:
  //  - Synchronous (format / IP / dot count): fast feedback as user types.
  //  - Asynchronous (`validateAll` — debounced 300ms): runs the chain
  //    `Params.reservedDomainSuffixes` RPC + apex check. Disables Confirm
  //    while pending or on error so a reserved-zone domain can't slip
  //    through to a `MsgCreateLease` whose `MsgSetItemCustomDomain` will
  //    then be rejected post-broadcast. The async result also drives the
  //    apex warning shown in this card (kept in sync with what the user
  //    actually typed).
  const editedDomainTrimmed = editedCustomDomain.trim();
  const editedDomainFormatError = editedDomainTrimmed
    ? validateCustomDomainFormat(editedDomainTrimmed)
    : null;
  const editedDomainHasContent = editedDomainTrimmed.length > 0;

  // Last-validated marker. The cached value is only valid for `domain`; if the
  // input has since changed, we're "pending" until the next debounce resolves.
  // No synchronous setState in the effect body — only inside the async resolve —
  // which keeps the React-hooks/set-state-in-effect lint happy.
  const [lastValidated, setLastValidated] = useState<{
    domain: string;
    error?: string;
    warning?: string;
  }>({ domain: '' });

  useEffect(() => {
    if (!isDeployApp || !editedDomainHasContent || editedDomainFormatError) return;
    if (lastValidated.domain === editedDomainTrimmed) return; // already validated
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await validateAll(editedDomainTrimmed);
        if (cancelled) return;
        setLastValidated({ domain: editedDomainTrimmed, error: result.error, warning: result.warning });
      } catch (err) {
        if (cancelled) return;
        logError('ConfirmationCard.asyncValidate', err);
        // Chain unreachable: store as "validated, no error/warning" so the chain
        // will reject authoritatively if it's actually a reserved zone.
        setLastValidated({ domain: editedDomainTrimmed });
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isDeployApp, editedDomainTrimmed, editedDomainHasContent, editedDomainFormatError, lastValidated.domain]);

  // Derived async-validation state. `pending` = the current input differs from
  // the last successfully-validated domain (and there's something to validate).
  // The async error/warning is only meaningful when the validated domain matches
  // the current input — otherwise display ignores it.
  const asyncDomainPending = editedDomainHasContent && !editedDomainFormatError &&
    lastValidated.domain !== editedDomainTrimmed;
  const asyncDomainError = lastValidated.domain === editedDomainTrimmed ? lastValidated.error : undefined;
  const asyncDomainWarning = lastValidated.domain === editedDomainTrimmed ? lastValidated.warning : undefined;
  const editedDomainError = editedDomainFormatError ?? asyncDomainError ?? null;

  // Multi-service stacks need an explicit service selection: without one the
  // chain receives `MsgSetItemCustomDomain` with no `service_name` and rejects.
  // The deploy_app TX would still go through, but the domain attach surfaces as
  // a post-broadcast "attach failed, retry" message — wasted UX. Block confirm
  // until the user picks one. We don't auto-pick the first service: which item
  // a domain attaches to is a meaningful choice that should be explicit.
  const stackServicePickerError = stackServiceNames !== undefined
    && editedDomainHasContent
    && !editedDomainFormatError
    && editedCustomDomainServiceName === '';

  const handleConfirm = useCallback(() => {
    const manifestOverride = editedManifest
      ? serializeManifest(editedManifest)
      : editedStack
        ? serializeStackManifest(editedStack)
        : undefined;

    if (!isDeployApp) {
      onConfirm(manifestOverride ? { editedManifestJson: manifestOverride } : undefined);
      return;
    }

    const overrides: ConfirmActionOverrides = {};
    if (manifestOverride) overrides.editedManifestJson = manifestOverride;
    overrides.editedCustomDomain = editedDomainTrimmed;
    overrides.editedCustomDomainServiceName = editedDomainTrimmed
      ? (stackServiceNames ? editedCustomDomainServiceName : '')
      : '';
    onConfirm(overrides);
  }, [editedManifest, editedStack, isDeployApp, editedDomainTrimmed, editedCustomDomainServiceName, stackServiceNames, onConfirm]);

  // Filter to user-facing args only. The AI tool schema in AI_TOOLS is the
  // single source of truth — this avoids the drift bug where every new TX
  // tool used to require a manual addition to the INTERNAL_ARGS allowlist.
  const displayArgs = useMemo(
    () => getDisplaySafeArgs(action.toolName, action.args),
    [action.toolName, action.args],
  );

  return (
    <FocusTrap focusTrapOptions={{
      escapeDeactivates: () => { if (!isExecuting) onCancel(); return false; },
      returnFocusOnDeactivate: true,
      initialFocus: () => cancelRef.current!,
      fallbackFocus: () => containerRef.current!,
    }}>
    <div
      ref={containerRef}
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

        {customDomainData ? (
          <CustomDomainBranch data={customDomainData} />
        ) : isStackEditable && editedStack ? (
          <div className="confirmation-details">
            <StackManifestEditor stack={editedStack} onChange={setEditedStack} />
          </div>
        ) : isEditable && editedManifest ? (
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
            ) : action.args.entries && Array.isArray(action.args.entries) && action.args.entries.length > 0 ? (
              <div className="confirmation-details">
                <p className="confirmation-details-title">
                  {action.toolName === 'stop_app' ? 'Apps to stop:' : action.toolName === 'restart_app' ? 'Apps to restart:' : 'Apps to deploy:'}
                </p>
                <ul className="confirmation-batch-list">
                  {(action.args.entries as Array<{ app_name: string; size?: string }>).map((entry) => (
                    <li key={entry.app_name}>{entry.app_name}{entry.size ? ` (${entry.size})` : ''}</li>
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
                      <SensitiveValue value={value} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {isDeployApp && (() => {
          const isApex = editedDomainHasContent && !editedDomainError && !!asyncDomainWarning;
          const recordKind = `${isApex ? 'an' : 'a'} ${apexRecordKindLabel(isApex)}${isApex ? ' record' : ''}`;
          const showSuccessHint = editedDomainHasContent && !editedDomainError && !asyncDomainPending;
          return (
            <div className="confirmation-details">
              <p className="confirmation-details-title">Custom domain (optional)</p>
              <div className="confirmation-payload">
                <input
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="app.example.com (leave empty to skip)"
                  value={editedCustomDomain}
                  onChange={(e) => setEditedCustomDomain(e.target.value)}
                  className="custom-domain-card__input"
                  aria-label="Custom domain"
                  aria-invalid={editedDomainError != null}
                  aria-busy={asyncDomainPending}
                />
                {stackServiceNames && editedDomainHasContent && (
                  <>
                    <select
                      value={editedCustomDomainServiceName}
                      onChange={(e) => setEditedCustomDomainServiceName(e.target.value)}
                      className="custom-domain-card__input mt-2"
                      aria-label="Service to attach domain to"
                      aria-invalid={stackServicePickerError}
                    >
                      <option value="">— pick a service —</option>
                      {stackServiceNames.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    {stackServicePickerError && (
                      <p className="text-xs text-error mt-1" role="alert">
                        Pick a service to attach the domain to.
                      </p>
                    )}
                  </>
                )}
                {asyncDomainPending && !editedDomainError && (
                  <p className="text-xs text-muted mt-2" aria-live="polite">Checking domain…</p>
                )}
                {editedDomainError && (
                  <p className="text-xs text-error mt-2" role="alert">{editedDomainError}</p>
                )}
                {showSuccessHint && (
                  <>
                    <p className="text-xs text-muted mt-2">
                      Will attach right after the lease is created. The provider FQDN appears
                      in the deploy result — add {recordKind} at your registrar pointing at it.
                    </p>
                    <CloudflareProxyHint inline />
                  </>
                )}
                {asyncDomainWarning && editedDomainHasContent && !editedDomainError && !asyncDomainPending && (
                  <p className="text-sm text-warning mt-2" role="alert">{asyncDomainWarning}</p>
                )}
              </div>
            </div>
          );
        })()}
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
          disabled={isExecuting || (isDeployApp && (editedDomainError != null || asyncDomainPending || stackServicePickerError))}
          className="btn btn-success btn-sm"
        >
          <Check className="w-4 h-4" />
          {isExecuting ? 'Executing...' : 'Confirm'}
        </button>
      </div>
    </div>
    </FocusTrap>
  );
});
