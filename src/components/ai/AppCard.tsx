/**
 * AppCard — rendered on successful deploy_app.
 * Shows app name, URL, status, cost info with action buttons.
 */

import { memo } from 'react';
import { Copy, Square, CheckCircle } from 'lucide-react';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { collectInstanceUrls } from '../../utils/connection';

interface PortMapping {
  host_ip: string;
  host_port: number;
}

interface ServiceInfo {
  ports?: Record<string, PortMapping>;
  instances?: { fqdn?: string; ports?: Record<string, PortMapping> }[];
}

interface AppCardProps {
  name: string;
  url?: string;
  connection?: {
    host: string;
    fqdn?: string;
    ports?: Record<string, PortMapping>;
    instances?: { fqdn?: string; ports?: Record<string, PortMapping> }[];
    services?: Record<string, ServiceInfo>;
  };
  status: string;
  onStop?: () => void;
}

export const AppCard = memo(function AppCard({ name, url, connection, status, onStop }: AppCardProps) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const instanceUrls = collectInstanceUrls(connection);
  const portEntries = connection?.ports ? Object.entries(connection.ports) : [];

  // Stack deployments: build service-grouped port list when no top-level ports
  const servicePortGroups: { serviceName: string; ports: [string, PortMapping][] }[] = [];
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
    if (copyTarget) copyToClipboard(copyTarget);
  };

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
              {u.replace('https://', '')}
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

      <div className="app-card__actions">
        {onStop && (
          <button
            type="button"
            onClick={onStop}
            className="btn btn-ghost btn-sm"
          >
            <Square className="w-3.5 h-3.5" aria-hidden="true" />
            Stop
          </button>
        )}
      </div>
    </div>
  );
});
