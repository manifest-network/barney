/**
 * DeployDnsStatusPill — chat-local DNS feedback after deploy.
 *
 * A single-line pill (DomainRow atom) emitted as a `displayCard` from
 * `executeConfirmedDeployApp` when a custom domain was attached during deploy.
 * Reads DNS status from the shared `dnsStatuses` store slice driven by the
 * sidebar's polling loop — no per-message poll loops, no double-polling.
 *
 * The user sees real-time DNS state right where the deploy success lands,
 * without needing to scroll up to the sidebar or run `app_status`.
 */

import { memo } from 'react';
import { useAI } from '../../hooks/useAI';
import { dnsStatusKey } from '../../stores/aiStore';
import { DomainRow } from './DomainRow';
import type { DeployDnsStatusCardData } from '../../contexts/aiTypes';

interface DeployDnsStatusPillProps {
  data: DeployDnsStatusCardData;
}

export const DeployDnsStatusPill = memo(function DeployDnsStatusPill({ data }: DeployDnsStatusPillProps) {
  const { dnsStatuses } = useAI();
  const report = dnsStatuses.get(dnsStatusKey(data.leaseUuid, data.fqdn));
  // Default to pending until the polling driver reports — no flash of "active".
  const status = report?.kind ?? 'pending_dns';
  const target = report?.expectedCnameTarget ?? data.expectedCnameTarget;

  return (
    <div className="deploy-dns-status-pill" role="status" aria-live="polite">
      <DomainRow
        fqdn={data.fqdn}
        expectedCnameTarget={target}
        status={status}
        serviceName={data.serviceName !== '' ? data.serviceName : undefined}
        inline
      />
      {data.isApex && (
        <p className="deploy-dns-status-pill__apex" role="alert">
          Apex domain — register an ALIAS / ANAME / CNAME-flattened record (CNAME at the apex is RFC-prohibited).
        </p>
      )}
    </div>
  );
});
