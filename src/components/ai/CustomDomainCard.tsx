/**
 * CustomDomainCard — rendered after a successful set_custom_domain TX (or re-emitted by app_status).
 * Self-polls DNS + HTTPS to compute a 4-state status. Polls every 30s when tab visible.
 */

import { memo, useCallback, useRef, useState } from 'react';
import { Globe, Copy, Check, AlertCircle } from 'lucide-react';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useVisibilityPolling } from '../../hooks/useVisibilityPolling';
import { useAI } from '../../hooks/useAI';
import {
  computeStatus,
  probeHttps,
  resolveDnsViaDoh,
  type CustomDomainStatus,
} from '../../utils/customDomainStatus';
import type { CustomDomainCardData } from '../../contexts/aiTypes';

const POLL_INTERVAL_MS = 30_000;
const STUCK_THRESHOLD_MS = 5 * 60 * 1000;

const STATUS_LABELS: Record<CustomDomainStatus, string> = {
  pending_dns: 'Pending DNS',
  issuing_cert: 'Issuing certificate',
  active: 'Active',
  failed: 'Failed',
};

const STATUS_DOT_CLASS: Record<CustomDomainStatus, string> = {
  pending_dns: 'custom-domain-card__status-dot--pending',
  issuing_cert: 'custom-domain-card__status-dot--issuing',
  active: 'custom-domain-card__status-dot--active',
  failed: 'custom-domain-card__status-dot--failed',
};

interface CustomDomainCardProps {
  data: CustomDomainCardData;
}

function StatusPill({ status }: { status: CustomDomainStatus }) {
  return (
    <span className="custom-domain-card__status-pill" aria-label={`Status: ${STATUS_LABELS[status]}`}>
      <span className={`custom-domain-card__status-dot ${STATUS_DOT_CLASS[status]}`} aria-hidden="true" />
      <span>{STATUS_LABELS[status]}</span>
    </span>
  );
}

export const CustomDomainCard = memo(function CustomDomainCard({ data }: CustomDomainCardProps) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const { sendMessage } = useAI();

  const [status, setStatus] = useState<CustomDomainStatus>('pending_dns');
  const [showStuckHint, setShowStuckHint] = useState(false);
  const pendingSinceRef = useRef<number | null>(null);

  const poll = useCallback(async () => {
    const [dns, https] = await Promise.all([
      resolveDnsViaDoh(data.fqdn),
      probeHttps(data.fqdn),
    ]);
    const next = computeStatus({ dns, https, expectedCname: data.expectedCnameTarget });
    setStatus(next);

    if (next === 'pending_dns') {
      pendingSinceRef.current ??= Date.now();
      setShowStuckHint(Date.now() - pendingSinceRef.current > STUCK_THRESHOLD_MS);
    } else {
      pendingSinceRef.current = null;
      setShowStuckHint(false);
    }
  }, [data.fqdn, data.expectedCnameTarget]);

  useVisibilityPolling(poll, POLL_INTERVAL_MS, { context: 'CustomDomainCard.poll' });

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
        <StatusPill status={status} />
      </div>

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
          DNS check unavailable from this network. Verify locally with{' '}
          <code className="font-mono">dig {data.fqdn}</code>.
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
});
