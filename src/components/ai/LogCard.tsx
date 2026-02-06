import { useState } from 'react';
import { ChevronDown, ChevronRight, Terminal, AlertTriangle } from 'lucide-react';

interface LogCardProps {
  appName: string;
  logs: Record<string, string>;
  truncated: boolean;
}

export function LogCard({ appName, logs, truncated }: LogCardProps) {
  const serviceNames = Object.keys(logs);
  const singleService = serviceNames.length === 1;
  const [expandedServices, setExpandedServices] = useState<Set<string>>(
    () => new Set(singleService ? serviceNames : [])
  );

  const toggleService = (service: string) => {
    setExpandedServices((prev) => {
      const next = new Set(prev);
      if (next.has(service)) {
        next.delete(service);
      } else {
        next.add(service);
      }
      return next;
    });
  };

  if (serviceNames.length === 0) {
    return (
      <div className="log-card">
        <div className="log-card-header">
          <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Logs: {appName}</span>
        </div>
        <div className="log-card-empty">No logs available</div>
      </div>
    );
  }

  return (
    <div className="log-card">
      <div className="log-card-header">
        <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
        <span>Logs: {appName}</span>
      </div>
      {serviceNames.map((service) => {
        const isExpanded = expandedServices.has(service);
        return (
          <div key={service} className="log-card-service">
            <button
              type="button"
              onClick={() => toggleService(service)}
              className="log-card-service-toggle"
              aria-expanded={isExpanded}
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} logs for ${service}`}
            >
              {isExpanded ? (
                <ChevronDown className="w-3 h-3" aria-hidden="true" />
              ) : (
                <ChevronRight className="w-3 h-3" aria-hidden="true" />
              )}
              <span>{service}</span>
            </button>
            {isExpanded && (
              <pre className="log-card-content">{logs[service]}</pre>
            )}
          </div>
        );
      })}
      {truncated && (
        <div className="log-card-truncated">
          <AlertTriangle className="w-3 h-3" aria-hidden="true" />
          <span>Logs truncated — use the tail parameter for more</span>
        </div>
      )}
    </div>
  );
}
