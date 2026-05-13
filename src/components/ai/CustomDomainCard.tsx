/**
 * CustomDomainCard — surfaces the custom-domain affordance for a deployed service.
 *
 * Three states (driven by the data shape):
 *  - `data.domains` set with N entries → consolidated multi-domain view (one row
 *    per domain via the `DomainRow` atom; shared CNAME instructions at top).
 *  - `data.fqdn === ''` → empty-form state ("no domain set"; input + service
 *    picker for stacks + Set + Ask Barney).
 *  - `data.fqdn !== ''` (single-domain) → status display (4-state polling pill,
 *    CNAME line, Change / Remove).
 *
 * Both single-domain and multi-domain views read DNS status from the shared
 * `dnsStatuses` store slice — the sole writer is `useDnsStatusPolling`,
 * mounted in `MainLayout`. No per-card polling loops. The single-domain card
 * additionally tracks its own "stuck" timer locally (a UI-only concern that
 * doesn't need cross-surface coherence).
 *
 * All three states route mutations through `useAI().sendMessage` so the AI
 * tool flow (validation → ConfirmationCard → broadcast) handles the chain
 * interaction.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Globe, Copy, Check, AlertCircle } from 'lucide-react';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useAI } from '../../hooks/useAI';
import type { CustomDomainStatusKind } from '../../utils/customDomainStatus';
import { validateCustomDomainFormat, isApex, apexRecordKindLabel } from '../../utils/customDomainValidation';
import { normalizeFqdn } from '../../utils/connection';
import { dnsStatusKey } from '../../stores/aiStore';
import { DomainRow } from './DomainRow';
import type { CustomDomainCardData } from '../../contexts/aiTypes';
import { DNS_STUCK_THRESHOLD_MS } from '../../config/constants';

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
  // Service picker for stacks — initial = AI-prefilled serviceName, else the
  // lone stack service when there's only one. Multi-service stacks start empty
  // to force an explicit pick (enforced by `stackNeedsService` below).
  const stackServices = data.serviceNames ?? [];
  const showServicePicker = stackServices.length > 1;
  const [selectedService, setSelectedService] = useState(
    data.serviceName || (stackServices.length === 1 ? stackServices[0] : ''),
  );

  const trimmed = normalizeFqdn(input);
  const looksValid = trimmed.length > 0 && validateCustomDomainFormat(trimmed) === null;
  const stackNeedsService = showServicePicker && selectedService === '';
  const canSet = looksValid && !stackNeedsService;

  const handleSet = useCallback(() => {
    if (!canSet) return;
    const svcSuffix = selectedService ? ` (service: ${selectedService})` : '';
    void sendMessage(`Point ${trimmed} at ${data.appName}${svcSuffix}`);
    setInput('');
  }, [sendMessage, canSet, trimmed, data.appName, selectedService]);

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
        {!showServicePicker && data.serviceName ? <> (service: <code className="font-mono">{data.serviceName}</code>)</> : null}
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
          disabled={!canSet}
          className="btn btn-primary btn-sm"
        >
          Set
        </button>
      </div>

      {showServicePicker && (
        <select
          value={selectedService}
          onChange={(e) => setSelectedService(e.target.value)}
          className="custom-domain-card__input mt-2"
          aria-label="Service to attach domain to"
        >
          <option value="">— pick a service —</option>
          {stackServices.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      )}

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
  const { sendMessage, dnsStatuses } = useAI();

  // Read from the shared slice driven by `useDnsStatusPolling` in MainLayout
  // — no local poll loop, no double-probing.
  const report = dnsStatuses.get(dnsStatusKey(data.leaseUuid, data.fqdn));
  const kind = report?.kind ?? 'pending_dns';
  const detail = report?.detail;
  const target = report?.expectedCnameTarget ?? data.expectedCnameTarget;

  // The stuck hint is purely a UI-side derivation: how long has this domain
  // been showing as pending_dns *since this card mounted*. The slice itself
  // doesn't carry that timestamp, and we don't need cross-component coherence
  // — each rendering of the card can re-arm.
  const pendingSinceRef = useRef<number | null>(null);
  const [showStuckHint, setShowStuckHint] = useState(false);
  useEffect(() => {
    if (kind !== 'pending_dns' || detail) {
      pendingSinceRef.current = null;
      setShowStuckHint(false);
      return;
    }
    pendingSinceRef.current ??= Date.now();
    const elapsed = Date.now() - pendingSinceRef.current;
    if (elapsed >= DNS_STUCK_THRESHOLD_MS) {
      setShowStuckHint(true);
      return;
    }
    const t = setTimeout(() => setShowStuckHint(true), DNS_STUCK_THRESHOLD_MS - elapsed);
    return () => clearTimeout(t);
  }, [kind, detail]);

  const handleChange = useCallback(() => {
    void sendMessage(`Change the custom domain for ${data.appName}`);
  }, [sendMessage, data.appName]);

  const handleRemove = useCallback(() => {
    const svcArg = data.serviceName ? ` (service: ${data.serviceName})` : '';
    void sendMessage(`Remove the custom domain from ${data.appName}${svcArg}`);
  }, [sendMessage, data.appName, data.serviceName]);

  // Apex CNAMEs are RFC-forbidden; the user can still accept the apex warning
  // in the ConfirmationCard, but the status view here must surface the right
  // record type so they don't paste a CNAME into their registrar and get
  // rejected. Pure sync — `isApex` uses tldts + Mozilla PSL with
  // `allowPrivateDomains: true` (covers github.io, netlify.app, vercel.app).
  const recordKind = apexRecordKindLabel(isApex(data.fqdn));

  return (
    <div className="custom-domain-card" role="article" aria-label={`Custom domain: ${data.fqdn}`}>
      <div className="custom-domain-card__header">
        <Globe className="w-4 h-4 text-primary-400" aria-hidden="true" />
        <span className="custom-domain-card__title">
          <span className="custom-domain-card__fqdn">{data.fqdn}</span>
        </span>
        <StatusPill kind={kind} />
      </div>

      {detail && (
        <p className="custom-domain-card__detail" aria-live="polite">{detail}</p>
      )}

      {target && (
        <div className="custom-domain-card__detail">
          {recordKind}{' '}
          <code className="font-mono">{data.fqdn}</code>{' '}
          &rarr;{' '}
          <code className="font-mono">{target}</code>{' '}
          <button
            type="button"
            onClick={() => copyToClipboard(target)}
            className="btn-icon"
            aria-label={`Copy ${recordKind} target`}
            title="Copy"
          >
            {isCopied(target) ? (
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
          DNS not visible yet. Public resolvers cache "not found" responses for several minutes
          after a record is created — this often resolves itself. If{' '}
          <code className="font-mono">dig {data.fqdn}</code>{' '}
          shows the record locally but Barney still doesn't see it, your network may be blocking
          the check.
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

function MultiDomainView({ data }: { data: CustomDomainCardData }) {
  const { dnsStatuses, sendMessage } = useAI();
  const domains = data.domains ?? [];

  const handleChange = useCallback((serviceName: string) => {
    const svcArg = serviceName ? ` (service: ${serviceName})` : '';
    void sendMessage(`Change the custom domain for ${data.appName}${svcArg}`);
  }, [sendMessage, data.appName]);

  const handleRemove = useCallback((serviceName: string) => {
    const svcArg = serviceName ? ` (service: ${serviceName})` : '';
    void sendMessage(`Remove the custom domain from ${data.appName}${svcArg}`);
  }, [sendMessage, data.appName]);

  return (
    <div className="custom-domain-card" role="article" aria-label={`Custom domains for ${data.appName}`}>
      <div className="custom-domain-card__header">
        <Globe className="w-4 h-4 text-primary-400" aria-hidden="true" />
        <span className="custom-domain-card__title">
          {data.appName} <span className="custom-domain-card__count">· {domains.length} domains</span>
        </span>
      </div>

      <p className="custom-domain-card__detail">
        Add the DNS record shown for each domain at your registrar — CNAME for
        subdomains, ALIAS / ANAME / CNAME-flattened for apex domains. Cloudflare
        proxy/orange-cloud OFF.
      </p>

      <div className="custom-domain-card__rows">
        {domains.map((d) => {
          const report = dnsStatuses.get(dnsStatusKey(data.leaseUuid, d.customDomain));
          return (
            <DomainRow
              key={d.customDomain}
              fqdn={d.customDomain}
              expectedCnameTarget={d.expectedCnameTarget ?? report?.expectedCnameTarget}
              status={report?.kind ?? 'pending_dns'}
              detail={report?.detail}
              serviceName={d.serviceName !== '' ? d.serviceName : undefined}
              actions={(
                <>
                  <button
                    type="button"
                    onClick={() => handleChange(d.serviceName)}
                    className="btn btn-ghost btn-sm"
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(d.serviceName)}
                    className="btn btn-ghost btn-sm"
                  >
                    Remove
                  </button>
                </>
              )}
            />
          );
        })}
      </div>
    </div>
  );
}

export const CustomDomainCard = memo(function CustomDomainCard({ data }: CustomDomainCardProps) {
  if (data.domains && data.domains.length > 0) {
    return <MultiDomainView data={data} />;
  }
  if (data.fqdn === '') {
    return <NoDomainForm data={data} />;
  }
  return <ActiveDomainView data={data} />;
});
