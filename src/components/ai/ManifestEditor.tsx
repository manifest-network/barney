import { useState, useCallback } from 'react';
import { Plus, Trash2, Lock, Eye, EyeOff, Copy, CheckCheck, Info } from 'lucide-react';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { isValidPort, type ManifestFields } from './manifestEditorUtils';

export type { ManifestFields };

export interface ManifestEditorProps {
  manifest: ManifestFields;
  onChange: (updated: ManifestFields) => void;
}

function InlineCopyButton({ value }: { value: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const copied = isCopied(value);
  return (
    <button type="button" onClick={() => copyToClipboard(value)} className="manifest-editor-icon-btn" aria-label="Copy to clipboard" title="Copy">
      {copied ? <CheckCheck className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5 text-muted" />}
    </button>
  );
}

function SensitiveActions({ value, revealed, onToggle }: { value: string; revealed: boolean; onToggle: () => void }) {
  return (
    <span className="manifest-editor-sensitive-actions">
      <button
        type="button"
        onClick={onToggle}
        className="manifest-editor-icon-btn"
        aria-label={revealed ? 'Hide value' : 'Reveal value'}
        title={revealed ? 'Hide' : 'Reveal'}
      >
        {revealed ? <EyeOff className="w-3.5 h-3.5 text-muted" /> : <Eye className="w-3.5 h-3.5 text-muted" />}
      </button>
      {revealed && <InlineCopyButton value={value} />}
    </span>
  );
}

function EnvRow({ envKey, value, onKeyChange, onValueChange, onRemove }: {
  envKey: string;
  value: string;
  onKeyChange: (oldKey: string, newKey: string) => void;
  onValueChange: (key: string, value: string) => void;
  onRemove: (key: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="manifest-editor-field">
      <input
        type="text"
        value={envKey}
        onChange={(e) => onKeyChange(envKey, e.target.value)}
        className="manifest-editor-input manifest-editor-input-key"
        aria-label={`Environment variable name: ${envKey}`}
      />
      <span className="text-muted text-xs">=</span>
      <input
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={(e) => onValueChange(envKey, e.target.value)}
        className="manifest-editor-input"
        aria-label={`Environment variable value: ${envKey}`}
      />
      <SensitiveActions value={value} revealed={revealed} onToggle={() => setRevealed((r) => !r)} />
      <button
        type="button"
        onClick={() => onRemove(envKey)}
        className="manifest-editor-icon-btn"
        aria-label={`Remove variable ${envKey}`}
        title="Remove"
      >
        <Trash2 className="w-3.5 h-3.5 text-muted" />
      </button>
    </div>
  );
}

export function ManifestEditor({ manifest, onChange }: ManifestEditorProps) {
  const [newPort, setNewPort] = useState('');
  const [newProtocol, setNewProtocol] = useState<'tcp' | 'udp'>('tcp');
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');
  const [newTmpfs, setNewTmpfs] = useState('');

  // --- Ports ---

  const portEntries = Object.keys(manifest.ports);

  const addPort = useCallback(() => {
    const portNum = newPort.trim();
    if (!isValidPort(portNum)) return;
    const key = `${portNum}/${newProtocol}`;
    if (manifest.ports[key] !== undefined) return;
    onChange({
      ...manifest,
      ports: { ...manifest.ports, [key]: {} as Record<string, never> },
    });
    setNewPort('');
  }, [manifest, newPort, newProtocol, onChange]);

  const removePort = useCallback((key: string) => {
    const rest = Object.fromEntries(Object.entries(manifest.ports).filter(([k]) => k !== key)) as Record<string, Record<string, never>>;
    onChange({ ...manifest, ports: rest });
  }, [manifest, onChange]);

  // --- Env vars ---

  const envEntries = Object.entries(manifest.env);

  const updateEnvKey = useCallback((oldKey: string, newKey: string) => {
    // Prevent silent overwrite if new key collides with an existing one
    if (newKey !== oldKey && manifest.env[newKey] !== undefined) return;
    const entries = Object.entries(manifest.env);
    const updated: Record<string, string> = {};
    for (const [k, v] of entries) {
      updated[k === oldKey ? newKey : k] = v;
    }
    onChange({ ...manifest, env: updated });
  }, [manifest, onChange]);

  const updateEnvValue = useCallback((key: string, value: string) => {
    onChange({
      ...manifest,
      env: { ...manifest.env, [key]: value },
    });
  }, [manifest, onChange]);

  const removeEnv = useCallback((key: string) => {
    const rest = Object.fromEntries(Object.entries(manifest.env).filter(([k]) => k !== key));
    onChange({ ...manifest, env: rest });
  }, [manifest, onChange]);

  const addEnv = useCallback(() => {
    const key = newEnvKey.trim();
    if (!key || manifest.env[key] !== undefined) return;
    onChange({
      ...manifest,
      env: { ...manifest.env, [key]: newEnvValue },
    });
    setNewEnvKey('');
    setNewEnvValue('');
  }, [manifest, newEnvKey, newEnvValue, onChange]);

  // --- User ---

  const updateUser = useCallback((value: string) => {
    onChange({
      ...manifest,
      user: value || undefined,
    });
  }, [manifest, onChange]);

  // --- Tmpfs ---

  const addTmpfs = useCallback(() => {
    const path = newTmpfs.trim();
    if (!path) return;
    const current = manifest.tmpfs ?? [];
    if (current.includes(path)) return;
    onChange({ ...manifest, tmpfs: [...current, path] });
    setNewTmpfs('');
  }, [manifest, newTmpfs, onChange]);

  const removeTmpfs = useCallback((path: string) => {
    onChange({
      ...manifest,
      tmpfs: (manifest.tmpfs ?? []).filter((p) => p !== path),
    });
  }, [manifest, onChange]);

  return (
    <div className="manifest-editor" data-testid="manifest-editor">
      {manifest.notice && (
        <div className="manifest-editor-notice" role="note">
          <Info className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>{manifest.notice}</span>
        </div>
      )}
      {/* Image (read-only) */}
      <div className="manifest-editor-section">
        <p className="confirmation-details-title flex items-center gap-1.5">
          <Lock className="w-3 h-3" aria-hidden="true" />
          Image
        </p>
        <div className="manifest-editor-field">
          <input
            type="text"
            value={manifest.image}
            readOnly
            className="manifest-editor-input manifest-editor-input-readonly"
            aria-label="Docker image (read-only)"
          />
        </div>
      </div>

      {/* Ports */}
      <div className="manifest-editor-section">
        <p className="confirmation-details-title">Ports</p>
        {portEntries.length > 0 && (
          <div className="manifest-editor-entries">
            {portEntries.map((key) => (
              <div key={key} className="manifest-editor-field">
                <code className="manifest-editor-port-label">{key}</code>
                <button
                  type="button"
                  onClick={() => removePort(key)}
                  className="manifest-editor-icon-btn"
                  aria-label={`Remove port ${key}`}
                  title="Remove"
                >
                  <Trash2 className="w-3.5 h-3.5 text-muted" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="manifest-editor-add-row">
          <input
            type="text"
            inputMode="numeric"
            value={newPort}
            onChange={(e) => setNewPort(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPort(); } }}
            placeholder="Port"
            className="manifest-editor-input manifest-editor-input-sm"
            aria-label="New port number"
          />
          <select
            value={newProtocol}
            onChange={(e) => setNewProtocol(e.target.value as 'tcp' | 'udp')}
            className="manifest-editor-input manifest-editor-input-xs"
            aria-label="Protocol"
          >
            <option value="tcp">tcp</option>
            <option value="udp">udp</option>
          </select>
          <button
            type="button"
            onClick={addPort}
            disabled={!newPort.trim() || !isValidPort(newPort.trim())}
            className="manifest-editor-add-btn"
            aria-label="Add port"
            title="Add port"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Env vars */}
      <div className="manifest-editor-section">
        <p className="confirmation-details-title">Environment Variables</p>
        {envEntries.length > 0 && (
          <div className="manifest-editor-entries">
            {envEntries.map(([key, value]) => (
              <EnvRow
                key={key}
                envKey={key}
                value={value}
                onKeyChange={updateEnvKey}
                onValueChange={updateEnvValue}
                onRemove={removeEnv}
              />
            ))}
          </div>
        )}
        <div className="manifest-editor-add-row">
          <input
            type="text"
            value={newEnvKey}
            onChange={(e) => setNewEnvKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEnv(); } }}
            placeholder="KEY"
            className="manifest-editor-input manifest-editor-input-key"
            aria-label="New variable name"
          />
          <span className="text-muted text-xs">=</span>
          <input
            type="text"
            value={newEnvValue}
            onChange={(e) => setNewEnvValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEnv(); } }}
            placeholder="value"
            className="manifest-editor-input"
            aria-label="New variable value"
          />
          <button
            type="button"
            onClick={addEnv}
            disabled={!newEnvKey.trim()}
            className="manifest-editor-add-btn"
            aria-label="Add variable"
            title="Add variable"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* User */}
      <div className="manifest-editor-section">
        <p className="confirmation-details-title">User</p>
        <div className="manifest-editor-field">
          <input
            type="text"
            value={manifest.user ?? ''}
            onChange={(e) => updateUser(e.target.value)}
            placeholder="uid:gid"
            className="manifest-editor-input"
            aria-label="Container user"
          />
        </div>
      </div>

      {/* Tmpfs */}
      <div className="manifest-editor-section">
        <p className="confirmation-details-title">Tmpfs Mounts</p>
        {(manifest.tmpfs ?? []).length > 0 && (
          <div className="manifest-editor-entries">
            {(manifest.tmpfs ?? []).map((path) => (
              <div key={path} className="manifest-editor-field">
                <code className="manifest-editor-port-label">{path}</code>
                <button
                  type="button"
                  onClick={() => removeTmpfs(path)}
                  className="manifest-editor-icon-btn"
                  aria-label={`Remove tmpfs ${path}`}
                  title="Remove"
                >
                  <Trash2 className="w-3.5 h-3.5 text-muted" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="manifest-editor-add-row">
          <input
            type="text"
            value={newTmpfs}
            onChange={(e) => setNewTmpfs(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTmpfs(); } }}
            placeholder="/tmp/path"
            className="manifest-editor-input"
            aria-label="New tmpfs path"
          />
          <button
            type="button"
            onClick={addTmpfs}
            disabled={!newTmpfs.trim()}
            className="manifest-editor-add-btn"
            aria-label="Add tmpfs path"
            title="Add tmpfs path"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
