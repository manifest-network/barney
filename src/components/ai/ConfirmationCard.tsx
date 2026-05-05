import { memo, useMemo, useRef, useState, useCallback } from 'react';
import { AlertTriangle, Check, X, Paperclip, Copy, CheckCheck, Eye, EyeOff } from 'lucide-react';
import { FocusTrap } from 'focus-trap-react';
import type { PendingAction } from '../../ai/toolExecutor';
import { formatFileSize } from '../../utils/format';
import { logError } from '../../utils/errors';
import { findExampleByAppName } from '../../config/exampleApps';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { ManifestEditor } from './ManifestEditor';
import { StackManifestEditor } from './StackManifestEditor';
import { validateCustomDomainFormat, apexRecordKindLabel } from '../../utils/customDomainValidation';
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

/** Internal args that should not be shown in the confirmation parameters. */
const INTERNAL_ARGS = new Set([
  '_generatedManifest',
  '_serviceNames',
  '_isStack',
  // set_custom_domain internal-ish args (rendered in custom branch instead)
  'leaseUuid',
  'serviceName',
  'customDomain',
  'currentDomain',
  'expectedCnameTarget',
  'warning',
  'address',
  // deploy_app + customDomain internal args (rendered in dedicated section)
  'customDomainServiceName',
  'customDomainWarning',
  // deploy_app internal pre-confirm args
  'skuUuid',
  'providerUuid',
  'providerUrl',
]);

interface CustomDomainBranchData {
  appName: string;
  serviceName: string;
  customDomain: string;
  currentDomain: string;
  expectedCnameTarget?: string;
  warning?: string;
}

function parseCustomDomainArgs(action: PendingAction): CustomDomainBranchData | null {
  if (action.toolName !== 'set_custom_domain') return null;
  const args = action.args;
  return {
    appName: typeof args.app_name === 'string' ? args.app_name : '',
    serviceName: typeof args.serviceName === 'string' ? args.serviceName : '',
    customDomain: typeof args.customDomain === 'string' ? args.customDomain : '',
    currentDomain: typeof args.currentDomain === 'string' ? args.currentDomain : '',
    expectedCnameTarget: typeof args.expectedCnameTarget === 'string' ? args.expectedCnameTarget : undefined,
    warning: typeof args.warning === 'string' ? args.warning : undefined,
  };
}

function CustomDomainBranch({ data }: { data: CustomDomainBranchData }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const isClear = data.customDomain === '';
  const target = data.expectedCnameTarget ?? '<provider FQDN — appears once the app is running>';
  const showTarget = !isClear && data.expectedCnameTarget;
  // Apex domains can't take a plain CNAME (RFC 1034 §3.6.2); validateAll surfaces a
  // warning we use as the apex signal so the DNS record table reads correctly.
  const isApex = !!data.warning;
  const recordType = apexRecordKindLabel(isApex);

  return (
    <div className="confirmation-details">
      {isClear ? (
        <div className="confirmation-payload" role="alert">
          <p className="text-sm text-warning">
            This will clear <code className="font-mono">{data.currentDomain}</code> from <code className="font-mono">{data.appName}</code>.
            HTTPS at that hostname will stop working until you point it at a new lease.
          </p>
        </div>
      ) : (
        <>
          <p className="confirmation-details-title">DNS record to add at your registrar</p>
          <table className="custom-domain-dns-table" aria-label="DNS record">
            <thead>
              <tr>
                <th>Type</th>
                <th>Name</th>
                <th>Value</th>
                <th>TTL</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code className="font-mono">{recordType}</code></td>
                <td>
                  <code className="font-mono">{data.customDomain}</code>
                  {' '}
                  <button
                    type="button"
                    onClick={() => copyToClipboard(data.customDomain)}
                    className="btn-icon"
                    aria-label="Copy domain"
                    title="Copy"
                  >
                    {isCopied(data.customDomain) ? (
                      <CheckCheck className="w-3.5 h-3.5 text-success" />
                    ) : (
                      <Copy className="w-3.5 h-3.5 text-muted" />
                    )}
                  </button>
                </td>
                <td>
                  <code className="font-mono">{target}</code>
                  {showTarget && (
                    <>
                      {' '}
                      <button
                        type="button"
                        onClick={() => copyToClipboard(data.expectedCnameTarget!)}
                        className="btn-icon"
                        aria-label="Copy target"
                        title="Copy"
                      >
                        {isCopied(data.expectedCnameTarget!) ? (
                          <CheckCheck className="w-3.5 h-3.5 text-success" />
                        ) : (
                          <Copy className="w-3.5 h-3.5 text-muted" />
                        )}
                      </button>
                    </>
                  )}
                </td>
                <td>Auto / 300</td>
              </tr>
            </tbody>
          </table>

          <p className="text-xs text-muted mt-2">
            Cloudflare users: turn the orange-cloud proxy <strong>off</strong> for this record. Issuance won't complete with proxy on.
          </p>

          {data.currentDomain !== '' && (
            <p className="text-xs text-muted mt-1">
              Replacing existing domain <code className="font-mono">{data.currentDomain}</code>.
            </p>
          )}

          {data.warning && (
            <p className="text-sm text-warning mt-2" role="alert">
              {data.warning}
            </p>
          )}
        </>
      )}
    </div>
  );
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

  // Validate the input synchronously. validateAll's reserved-suffix check is
  // async (chain RPC); we let the chain reject on broadcast for that case.
  // The format/IP check is synchronous and gives fast feedback.
  const editedDomainTrimmed = editedCustomDomain.trim();
  const editedDomainError = editedDomainTrimmed
    ? validateCustomDomainFormat(editedDomainTrimmed)
    : null;
  const editedDomainHasContent = editedDomainTrimmed.length > 0;

  // The apex warning is a soft signal (validateAll runs async upstream); when
  // the user EDITS the domain we drop the cached warning since the new input
  // hasn't been re-validated. Confirm always runs the executor's validateAll.
  const editedDomainChanged = editedDomainTrimmed !== initialDomain;
  const carriedWarning = !editedDomainChanged && typeof action.args.customDomainWarning === 'string'
    ? action.args.customDomainWarning
    : undefined;

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
          const isApex = editedDomainHasContent && !editedDomainError && !!carriedWarning;
          const recordKind = `${isApex ? 'an' : 'a'} ${apexRecordKindLabel(isApex)}${isApex ? ' record' : ''}`;
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
                />
                {stackServiceNames && editedDomainHasContent && (
                  <select
                    value={editedCustomDomainServiceName}
                    onChange={(e) => setEditedCustomDomainServiceName(e.target.value)}
                    className="custom-domain-card__input mt-2"
                    aria-label="Service to attach domain to"
                  >
                    <option value="">— pick a service —</option>
                    {stackServiceNames.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                )}
                {editedDomainError && (
                  <p className="text-xs text-error mt-2" role="alert">{editedDomainError}</p>
                )}
                {editedDomainHasContent && !editedDomainError && (
                  <p className="text-xs text-muted mt-2">
                    Will attach right after the lease is created. The provider FQDN appears
                    in the deploy result — add {recordKind} at your registrar pointing at it,
                    with Cloudflare proxy/orange-cloud OFF.
                  </p>
                )}
                {carriedWarning && editedDomainHasContent && !editedDomainError && (
                  <p className="text-sm text-warning mt-2" role="alert">{carriedWarning}</p>
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
          disabled={isExecuting || (isDeployApp && editedDomainError != null)}
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
