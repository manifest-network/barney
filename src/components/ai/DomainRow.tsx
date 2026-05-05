/**
 * DomainRow — the cross-cutting `dot + fqdn + → + target` atom.
 *
 * Used by:
 *  - AppsSidebar tooltip (per-domain detail when an app has multiple)
 *  - The inline deploy_dns_status pill (chat-local feedback after deploy)
 *  - The consolidated CustomDomainCard (one row per domain)
 *
 * Same OKLCH status tokens, same IBM Plex Mono for the FQDN, same arrow.
 * Single visual vocabulary for custom domains across the app.
 */

import { memo } from 'react';
import { Copy, Check, ArrowRight } from 'lucide-react';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import type { CustomDomainStatusKind } from '../../utils/customDomainStatus';

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

interface DomainRowProps {
  fqdn: string;
  expectedCnameTarget?: string;
  status: CustomDomainStatusKind;
  /** Free-form sub-reason rendered as a second line under the row. Today this
   *  is only set on wrong-target detection (`Pointed at X — expected Y`). */
  detail?: string;
  /** Optional service name displayed as a small badge (multi-service stacks). */
  serviceName?: string;
  /** Optional action buttons rendered at the row's end (e.g. Change/Remove). */
  actions?: React.ReactNode;
  /** When true, renders without the row chrome (border/padding) — used inside
   *  the inline deploy pill where the surrounding message already provides the chrome. */
  inline?: boolean;
}

export const DomainRow = memo(function DomainRow({
  fqdn,
  expectedCnameTarget,
  status,
  detail,
  serviceName,
  actions,
  inline = false,
}: DomainRowProps) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const target = expectedCnameTarget;

  return (
    <div
      className={`domain-row ${inline ? 'domain-row--inline' : ''}`}
      role="group"
      aria-label={`${fqdn}: ${STATUS_LABELS[status]}${detail ? `. ${detail}` : ''}`}
    >
      <div className="domain-row__main">
        <span
          className={`custom-domain-card__status-dot ${STATUS_DOT_CLASS[status]}`}
          aria-hidden="true"
        />
        <code className="domain-row__fqdn font-mono">{fqdn}</code>
        {target && (
          <>
            <ArrowRight className="domain-row__arrow w-3 h-3" aria-hidden="true" />
            <button
              type="button"
              onClick={() => copyToClipboard(target)}
              className="domain-row__target-btn"
              aria-label={`Copy CNAME target ${target}`}
              title={isCopied(target) ? 'Copied' : 'Click to copy'}
            >
              <code className="font-mono">{target}</code>
              {isCopied(target) ? (
                <Check className="w-3 h-3 text-success-400" aria-hidden="true" />
              ) : (
                <Copy className="w-3 h-3 text-muted" aria-hidden="true" />
              )}
            </button>
          </>
        )}
        {serviceName && (
          <span className="domain-row__service" aria-label={`Service ${serviceName}`}>
            {serviceName}
          </span>
        )}
        <span className="domain-row__status-label">{STATUS_LABELS[status]}</span>
        {actions && <span className="domain-row__actions">{actions}</span>}
      </div>
      {detail && (
        <p className="domain-row__detail" role="status">
          {detail}
        </p>
      )}
    </div>
  );
});
