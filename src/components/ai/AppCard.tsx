/**
 * AppCard — rendered on successful deploy_app.
 *
 * Shows app name, URL, port mappings, optional custom-domain row, and a Stop
 * affordance routed through the AI flow. When a custom domain was attached
 * during deploy, the embedded `DomainRow` reads its live status from the
 * shared `dnsStatuses` slice — same pattern as every other custom-domain
 * surface (no per-component polling).
 */

import { memo } from 'react';
import { Copy, Square, CheckCircle } from 'lucide-react';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useAI } from '../../hooks/useAI';
import { collectInstanceUrls } from '../../utils/connection';
import { dnsStatusKey } from '../../stores/aiStore';
import { DomainRow } from './DomainRow';
import type { AppCardData } from '../../contexts/aiTypes';

interface AppCardProps {
  data: AppCardData;
}

export const AppCard = memo(function AppCard({ data }: AppCardProps) {
  const { name, url, connection, status, customDomain } = data;
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const { requestStopApp, dnsStatuses } = useAI();

  const instanceUrls = collectInstanceUrls(connection);
  const portEntries = connection?.ports ? Object.entries(connection.ports) : [];

  // Stack deployments: build service-grouped port list when no top-level ports
  const servicePortGroups: { serviceName: string; ports: [string, { host_ip: string; host_port: number }][] }[] = [];
  if (portEntries.length === 0 && connection?.services) {
    for (const [svcName, svc] of Object.entries(connection.services)) {
      const svcPorts = svc.ports ?? svc.instances?.[0]?.ports;
      if (svcPorts) {
        const entries = Object.entries(svcPorts);
        if (entries.length > 0) {
          servicePortGroups.push({ serviceName: svcName, ports: entries });
        }
      }
    }
  }

  let copyTarget: string | undefined;
  if (portEntries.length > 0) {
    copyTarget = `${portEntries[0][1].host_ip}:${portEntries[0][1].host_port}`;
  } else if (servicePortGroups.length > 0) {
    const first = servicePortGroups[0].ports[0][1];
    copyTarget = `${first.host_ip}:${first.host_port}`;
  } else {
    copyTarget = url;
  }

  const copied = copyTarget ? isCopied(copyTarget) : false;
  const handleCopy = () => {
    if (copyTarget) void copyToClipboard(copyTarget);
  };

  const handleStop = () => {
    // Route directly to the store action — bypassing the natural-language
    // `sendMessage("Stop ${name}")` prompt — so app names that collide with
    // `stop_app`'s bulk-stop sentinel (e.g. `"all"`) don't trigger
    // stop-everything intent on the model side. See PR #93 Copilot 3244138206.
    requestStopApp(name);
  };

  const domainReport = customDomain
    ? dnsStatuses.get(dnsStatusKey(customDomain.leaseUuid, customDomain.fqdn))
    : undefined;

  return (
    <div className="app-card" role="article" aria-label={`App: ${name}`}>
      <div className="app-card__header">
        <CheckCircle className="w-5 h-5 text-success-400" aria-hidden="true" />
        <span className="app-card__name">{name}</span>
        <span className="app-card__status">{status}</span>
      </div>

      {url && (
        <div className="app-card__url">
          <span className="app-card__link">{url}</span>
          <button
            type="button"
            onClick={handleCopy}
            className="app-card__copy"
            aria-label={copied ? 'Copied' : 'Copy endpoint'}
          >
            {copied ? (
              <CheckCircle className="w-3.5 h-3.5 text-success-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      )}

      {instanceUrls.length > 0 && (
        <div className="app-card__instances">
          <span className="app-card__instances-label">Instances</span>
          {instanceUrls.map(u => (
            <span key={u} className="app-card__instance-link">
              {u}
            </span>
          ))}
        </div>
      )}

      {portEntries.length > 0 && (
        <div className="app-card__ports">
          {portEntries.map(([containerPort, mapping]) => (
            <span key={containerPort} className="app-card__port">
              {containerPort} &rarr; {mapping.host_ip}:{mapping.host_port}
            </span>
          ))}
        </div>
      )}

      {servicePortGroups.length > 0 && (
        <div className="app-card__ports">
          {servicePortGroups.map(({ serviceName, ports }) => (
            <div key={serviceName} className="app-card__service-ports">
              <span className="app-card__service-name">{serviceName}</span>
              {ports.map(([containerPort, mapping]) => (
                <span key={`${serviceName}-${containerPort}`} className="app-card__port">
                  {containerPort} &rarr; {mapping.host_ip}:{mapping.host_port}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      {customDomain && (
        <div className="app-card__domain">
          <DomainRow
            fqdn={customDomain.fqdn}
            expectedCnameTarget={domainReport?.expectedCnameTarget ?? customDomain.expectedCnameTarget}
            status={domainReport?.kind ?? 'pending_dns'}
            detail={domainReport?.detail}
            serviceName={customDomain.serviceName !== '' ? customDomain.serviceName : undefined}
            inline
          />
          {customDomain.isApex && (
            <p className="app-card__apex-warning" role="alert">
              Apex domain — register an ALIAS / ANAME / CNAME-flattened record (CNAME at the apex is RFC-prohibited).
            </p>
          )}
        </div>
      )}

      <div className="app-card__actions">
        <button
          type="button"
          onClick={handleStop}
          className="btn btn-ghost btn-sm"
        >
          <Square className="w-3.5 h-3.5" aria-hidden="true" />
          Stop
        </button>
      </div>
    </div>
  );
});
