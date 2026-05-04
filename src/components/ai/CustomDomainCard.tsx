/**
 * CustomDomainCard — surfaces the custom-domain affordance for a deployed service.
 *
 * Two states:
 *  - data.fqdn === ''  → "no domain set" form (input + Set + Ask Barney)
 *  - data.fqdn !== ''  → status display (4-state polling, Change / Remove)
 *
 * Both states route through `useAI().sendMessage` so the AI tool flow
 * (validation → ConfirmationCard → broadcast) handles the chain interaction.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Globe, Copy, Check, AlertCircle } from 'lucide-react';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useVisibilityPolling } from '../../hooks/useVisibilityPolling';
import { useAI } from '../../hooks/useAI';
import {
  computeStatus,
  probeHttps,
  resolveDnsViaDoh,
  type CustomDomainStatusKind,
  type CustomDomainStatusReport,
} from '../../utils/customDomainStatus';
import { isValidFqdn } from '../../utils/connection';
import type { CustomDomainCardData } from '../../contexts/aiTypes';

const POLL_INTERVAL_MS = 30_000;
const STUCK_THRESHOLD_MS = 5 * 60 * 1000;

const STATUS_LABELS: Record<CustomDomainStatusKind, string> = {
  pending_dns: 'Pending DNS',
  issuing_cert: 'Issuing certificate',
  active: 'Active',
  failed: 'Failed',
};

const STATUS_DOT_CLASS: Record<CustomDomainStatusKind, string> = {
  pending_dns: 'custom-domain-card__status-dot--pending',
  issuing_cert: 'custom-domain-card__status-dot--issuing',
  active: 'custom-domain-card__status-dot--active',
  failed: 'custom-domain-card__status-dot--failed',
};

interface CustomDomainCardProps {
  data: CustomDomainCardData;
}

function StatusPill({ kind }: { kind: CustomDomainStatusKind }) {
  return (
    <span className="custom-domain-card__status-pill" aria-label={`Status: ${STATUS_LABELS[kind]}`}>
      <span className={`custom-domain-card__status-dot ${STATUS_DOT_CLASS[kind]}`} aria-hidden="true" />
      <span>{STATUS_LABELS[kind]}</span>
    </span>
  );
}

function NoDomainForm({ data }: { data: CustomDomainCardData }) {
  const { sendMessage } = useAI();
  const [input, setInput] = useState('');
  const trimmed = input.trim().replace(/\.$/, '').toLowerCase();
  const looksValid = trimmed.length > 0 && isValidFqdn(trimmed) && trimmed.includes('.');

  const handleSet = useCallback(() => {
    if (!looksValid) return;
    const svcSuffix = data.serviceName ? ` (service: ${data.serviceName})` : '';
    void sendMessage(`Point ${trimmed} at ${data.appName}${svcSuffix}`);
    setInput('');
  }, [sendMessage, looksValid, trimmed, data.appName, data.serviceName]);

  const handleAskBarney = useCallback(() => {
    void sendMessage(`Help me set a custom domain for ${data.appName}`);
  }, [sendMessage, data.appName]);

  return (
    <div className="custom-domain-card" role="article" aria-label={`Custom domain for ${data.appName}`}>
      <div className="custom-domain-card__header">
        <Globe className="w-4 h-4 text-primary-400" aria-hidden="true" />
        <span className="custom-domain-card__title">Custom domain</span>
      </div>

      <p className="custom-domain-card__detail">
        Attach a hostname like <code className="font-mono">app.example.com</code> to{' '}
        <code className="font-mono">{data.appName}</code>
        {data.serviceName ? <> (service: <code className="font-mono">{data.serviceName}</code>)</> : null}
        .
      </p>

      <div className="custom-domain-card__form">
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="app.example.com"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSet(); }}
          className="custom-domain-card__input"
          aria-label="Custom domain"
        />
        <button
          type="button"
          onClick={handleSet}
          disabled={!looksValid}
          className="btn btn-primary btn-sm"
        >
          Set
        </button>
      </div>

      <div className="custom-domain-card__actions">
        <button
          type="button"
          onClick={handleAskBarney}
          className="btn btn-ghost btn-sm"
        >
          Ask Barney
        </button>
      </div>
    </div>
  );
}

function ActiveDomainView({ data }: { data: CustomDomainCardData }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const { sendMessage } = useAI();

  const [status, setStatus] = useState<CustomDomainStatusReport>({ kind: 'pending_dns' });
  const [showStuckHint, setShowStuckHint] = useState(false);
  const pendingSinceRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight probes when the card unmounts so they don't outlive the component.
  useEffect(() => () => abortRef.current?.abort(), []);

  const poll = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const [dns, https] = await Promise.all([
      resolveDnsViaDoh(data.fqdn, ac.signal),
      probeHttps(data.fqdn, ac.signal),
    ]);
    if (ac.signal.aborted) return;
    const next = computeStatus({ dns, https, expectedCname: data.expectedCnameTarget });
    setStatus(next);

    if (next.kind === 'pending_dns') {
      pendingSinceRef.current ??= Date.now();
      setShowStuckHint(Date.now() - pendingSinceRef.current > STUCK_THRESHOLD_MS);
    } else {
      pendingSinceRef.current = null;
      setShowStuckHint(false);
    }
  }, [data.fqdn, data.expectedCnameTarget]);

  // Stop polling once we reach a terminal state. The user can refresh via app_status if
  // an externally-broken domain needs to be re-detected.
  useVisibilityPolling(poll, POLL_INTERVAL_MS, {
    context: 'CustomDomainCard.poll',
    enabled: status.kind !== 'active' && status.kind !== 'failed',
  });

  const handleChange = useCallback(() => {
    void sendMessage(`Change the custom domain for ${data.appName}`);
  }, [sendMessage, data.appName]);

  const handleRemove = useCallback(() => {
    const svcArg = data.serviceName ? ` (service: ${data.serviceName})` : '';
    void sendMessage(`Remove the custom domain from ${data.appName}${svcArg}`);
  }, [sendMessage, data.appName, data.serviceName]);

  return (
    <div className="custom-domain-card" role="article" aria-label={`Custom domain: ${data.fqdn}`}>
      <div className="custom-domain-card__header">
        <Globe className="w-4 h-4 text-primary-400" aria-hidden="true" />
        <span className="custom-domain-card__title">
          <span className="custom-domain-card__fqdn">{data.fqdn}</span>
        </span>
        <StatusPill kind={status.kind} />
      </div>

      {status.detail && (
        <p className="custom-domain-card__detail" aria-live="polite">{status.detail}</p>
      )}

      {data.expectedCnameTarget && (
        <div className="custom-domain-card__detail">
          CNAME{' '}
          <code className="font-mono">{data.fqdn}</code>{' '}
          &rarr;{' '}
          <code className="font-mono">{data.expectedCnameTarget}</code>{' '}
          <button
            type="button"
            onClick={() => copyToClipboard(data.expectedCnameTarget!)}
            className="btn-icon"
            aria-label="Copy CNAME target"
            title="Copy"
          >
            {isCopied(data.expectedCnameTarget) ? (
              <Check className="w-3 h-3 text-success-400" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
        </div>
      )}

      {showStuckHint && (
        <p className="custom-domain-card__hint" role="alert">
          <AlertCircle className="w-3 h-3 inline mr-1" aria-hidden="true" />
          DNS not visible yet. Verify with{' '}
          <code className="font-mono">dig {data.fqdn}</code>{' '}
          locally — if the record is published but doesn't appear here, your network may be blocking the check.
        </p>
      )}

      {data.serviceName && (
        <p className="custom-domain-card__detail">
          Service: <code className="font-mono">{data.serviceName}</code>
        </p>
      )}

      <div className="custom-domain-card__actions">
        <button type="button" onClick={handleChange} className="btn btn-ghost btn-sm">
          Change
        </button>
        <button type="button" onClick={handleRemove} className="btn btn-ghost btn-sm">
          Remove
        </button>
      </div>
    </div>
  );
}

export const CustomDomainCard = memo(function CustomDomainCard({ data }: CustomDomainCardProps) {
  if (data.fqdn === '') {
    return <NoDomainForm data={data} />;
  }
  return <ActiveDomainView data={data} />;
});
