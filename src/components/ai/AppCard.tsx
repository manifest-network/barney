/**
 * AppCard — app overview from app_status or a successful deploy_app.
 *
 * Shows app name, URL, port mappings, optional custom-domain row, and a Stop
 * affordance routed through the AI flow. When a custom domain was attached
 * during deploy, the embedded `DomainRow` reads its live status from the
 * shared `dnsStatuses` slice — same pattern as every other custom-domain
 * surface (no per-component polling).
 */

import { memo, useId, useState } from 'react';
import { Circle, Copy, Globe, Square, CheckCircle } from 'lucide-react';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useAIStore } from '../../contexts/aiStoreContext';
import { collectInstanceUrls, formatPortEndpoint, isValidFqdn, nonEmptyPorts } from '../../utils/connection';
import { dnsStatusKey } from '../../stores/aiStore';
import { DomainRow } from './DomainRow';
import { CustomDomainCard } from './CustomDomainCard';
import type { AppCardData, AppCardPortMapping } from '../../contexts/aiTypes';

interface AppCardProps {
  data: AppCardData;
}

export const AppCard = memo(function AppCard({ data }: AppCardProps) {
  const { name, status, providerStatus, customDomain, statusUnavailable, endpointStale, providerEndpoint, connectionStale, endpointInactive, url, connection, domainManagement } = data;
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const requestStopApp = useAIStore((state) => state.requestStopApp);
  const domainReport = useAIStore((state) => customDomain
    ? state.dnsStatuses.get(dnsStatusKey(customDomain.leaseUuid, customDomain.fqdn))
    : undefined);
  const [showDomains, setShowDomains] = useState(false);
  const domainsId = useId();

  const instanceUrls = collectInstanceUrls(connection);
  const portEntries = connection?.ports ? Object.entries(connection.ports) : [];

  // URL shaping hoists primary-service ports; prefer the full service inventory.
  const servicePortGroups: { serviceName: string; fqdn?: string; ports: [string, AppCardPortMapping][] }[] = [];
  const serviceNames = new Set([...Object.keys(connection?.services ?? {}), ...(data.serviceNames ?? [])]);
  const missingServices: string[] = [];
  const internalServices: string[] = [];
  for (const serviceName of serviceNames) {
    const svc = connection?.services?.[serviceName];
    const svcPorts = nonEmptyPorts(svc?.ports) ?? nonEmptyPorts(svc?.instances?.[0]?.ports);
    const reportedFqdn = svc?.fqdn ?? svc?.instances?.[0]?.fqdn;
    const fqdn = reportedFqdn && isValidFqdn(reportedFqdn) ? reportedFqdn : undefined;
    if (svcPorts || fqdn) {
      servicePortGroups.push({ serviceName, ports: Object.entries(svcPorts ?? {}), fqdn });
    } else if (svc && (Object.keys(svc).length === 0 || svc.ports || svc.instances !== undefined)) {
      internalServices.push(serviceName);
    } else {
      missingServices.push(serviceName);
    }
  }

  const handleStop = () => {
    // Route directly to the store action — bypassing the natural-language
    // `sendMessage("Stop ${name}")` prompt — so app names that collide with
    // `stop_app`'s bulk-stop sentinel (e.g. `"all"`) don't trigger
    // stop-everything intent on the model side. See PR #93 Copilot 3244138206.
    requestStopApp(name);
  };

  const serviceDetails = (
    <>
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

      {!servicePortGroups.some((group) => group.ports.length > 0) && portEntries.length > 0 && (
        <div className="app-card__ports">
          {serviceNames.size > 0 && <span className="app-card__service-name">Deployment ports</span>}
          {portEntries.map(([containerPort, mapping]) => (
            <span key={containerPort} className="app-card__port">
              {containerPort} &rarr; {formatPortEndpoint(mapping, connection?.host) ?? 'Endpoint unavailable'}
            </span>
          ))}
        </div>
      )}

      {servicePortGroups.length > 0 && (
        <div className="app-card__ports">
          {servicePortGroups.map(({ serviceName, ports, fqdn }) => (
            <div key={serviceName} className="app-card__service-ports">
              <span className="app-card__service-name">{serviceName}</span>
              {fqdn && <span className="app-card__service-endpoint">{fqdn}</span>}
              {ports.map(([containerPort, mapping]) => (
                <span key={`${serviceName}-${containerPort}`} className="app-card__port">
                  {containerPort} &rarr; {formatPortEndpoint(mapping, connection?.host) ?? 'Endpoint unavailable'}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      {missingServices.length > 0 && <p className="app-card__detail">Service details unavailable for: {missingServices.join(', ')}.</p>}
      {internalServices.map((serviceName) => <p key={serviceName} className="app-card__detail">{serviceName}: No published ports.</p>)}
    </>
  );

  return (
    <div className="app-card" data-status={statusUnavailable ? 'unavailable' : status} role="article" aria-label={`App: ${name}`}>
      <div className="app-card__header">
        {status === 'running' && !statusUnavailable
          ? <CheckCircle className="w-5 h-5 text-success-400" aria-hidden="true" />
          : <Circle className="w-5 h-5 text-surface-400" aria-hidden="true" />}
        <span className="app-card__name">{name}</span>
        <span className="app-card__status">{statusUnavailable ? 'Status unavailable' : status}</span>
      </div>

      {statusUnavailable && <p className="app-card__detail">Recorded status: {status}. Current lease status could not be confirmed.</p>}
      {data.chainState && data.chainState !== 'unknown' && <p className="app-card__detail">Lease status: {data.chainState}</p>}
      {data.workloadStatusUnavailable && <p className="app-card__detail">Workload status unavailable.</p>}
      {providerStatus && <p className="app-card__detail">Provider status: {providerStatus}</p>}
      {endpointInactive ? <p className="app-card__detail">Deployment endpoint is no longer active.</p> : <>
        {endpointStale && <p className="app-card__detail">{data.providerQuerySkipped ? 'Saved endpoint' : 'Last known endpoint — this read did not confirm a current endpoint.'}</p>}
        {!url && <p className="app-card__detail">Endpoint unavailable</p>}
      </>}

      {url && (
        <div className="app-card__url">
          <span className="app-card__link">{url}</span>
          <button
            type="button"
            onClick={() => void copyToClipboard(url)}
            className="app-card__copy"
            aria-label={isCopied(url) ? 'Copied' : 'Copy endpoint'}
          >
            {isCopied(url) ? (
              <CheckCircle className="w-3.5 h-3.5 text-success-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      )}

      {providerEndpoint && <div className="app-card__url">
        <span className="app-card__detail">Provider-reported endpoint</span>
        <span className="app-card__link">{providerEndpoint}</span>
        <button type="button" onClick={() => void copyToClipboard(providerEndpoint)} className="app-card__copy"
          aria-label={isCopied(providerEndpoint) ? 'Copied provider-reported endpoint' : 'Copy provider-reported endpoint'}>
          {isCopied(providerEndpoint) ? <CheckCircle className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>}

      {connectionStale ? (
        <details className="app-card__saved-connections">
          <summary>{data.providerQuerySkipped ? 'Saved service details' : 'Last known service details'}</summary>
          {!data.providerQuerySkipped && <p className="app-card__detail">Current service access details could not be confirmed.</p>}
          {serviceDetails}
        </details>
      ) : serviceDetails}

      {customDomain && (
        <div className="app-card__domain">
          <DomainRow
            fqdn={customDomain.fqdn}
            expectedCnameTarget={domainReport ? domainReport.expectedCnameTarget : customDomain.expectedCnameTarget}
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
        {(data.canStop ?? status !== 'stopped') && (
          <button
            type="button"
            onClick={handleStop}
            className="btn btn-ghost btn-sm"
          >
            <Square className="w-3.5 h-3.5" aria-hidden="true" />
            Stop
          </button>
        )}
        {domainManagement && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={showDomains}
            aria-controls={showDomains ? domainsId : undefined}
            onClick={() => setShowDomains(!showDomains)}
          >
            <Globe className="w-3.5 h-3.5" aria-hidden="true" />
            {domainManagement.fqdn || domainManagement.domains?.length ? 'Manage custom domains' : 'Set custom domain'}
          </button>
        )}
      </div>
      {domainManagement && showDomains && (
        <div id={domainsId} className="app-card__domain-management">
          <CustomDomainCard data={domainManagement} />
        </div>
      )}
    </div>
  );
});
