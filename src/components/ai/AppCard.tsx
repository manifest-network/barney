/**
 * AppCard — rendered on successful deploy_app.
 * Shows app name, URL, status, cost info with action buttons.
 */

import { memo, useState } from 'react';
import { ExternalLink, Copy, Square, CheckCircle } from 'lucide-react';
import { COPY_FEEDBACK_DURATION_MS } from '../../config/constants';

interface PortMapping {
  host_ip: string;
  host_port: number;
}

interface ServiceInfo {
  ports?: Record<string, PortMapping>;
  instances?: { ports?: Record<string, PortMapping> }[];
}

interface AppCardProps {
  name: string;
  url?: string;
  connection?: {
    host: string;
    ports?: Record<string, PortMapping>;
    services?: Record<string, ServiceInfo>;
  };
  status: string;
  onStop?: () => void;
}

export const AppCard = memo(function AppCard({ name, url, connection, status, onStop }: AppCardProps) {
  const [copied, setCopied] = useState(false);

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

  const handleCopy = async () => {
    if (!copyTarget) return;
    try {
      await navigator.clipboard.writeText(copyTarget);
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
    } catch {
      // Clipboard API may not be available
    }
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
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="app-card__link"
          >
            {url}
            <ExternalLink className="w-3 h-3 ml-1" aria-hidden="true" />
          </a>
          <button
            type="button"
            onClick={handleCopy}
            className="app-card__copy"
            aria-label={copied ? 'Copied' : 'Copy URL'}
          >
            {copied ? (
              <CheckCircle className="w-3.5 h-3.5 text-success-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
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
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary btn-sm"
          >
            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            Open
          </a>
        )}
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
