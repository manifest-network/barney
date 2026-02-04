/**
 * Renders connection info in a structured, user-friendly format.
 * Displays host, ports, protocol, and metadata from the provider API response.
 */

import { Wifi, X } from 'lucide-react';
import type { LeaseConnectionResponse } from '../../../api/provider-api';
import { CopyButton } from '../../ui/CopyButton';
import { formatKey } from './utils';

interface ConnectionInfoPanelProps {
  info: LeaseConnectionResponse;
  copyToClipboard: (text: string) => void;
  isCopied: (text: string) => boolean;
  onClose: () => void;
}

export function ConnectionInfoPanel({
  info,
  copyToClipboard,
  isCopied,
  onClose,
}: ConnectionInfoPanelProps) {
  const { connection } = info;
  const hasPort = connection.ports && Object.keys(connection.ports).length > 0;
  const hasMetadata = connection.metadata && Object.keys(connection.metadata).length > 0;

  // Build a connection string for easy copying (host:first_port)
  const firstPort = hasPort ? Object.values(connection.ports!)[0] : null;
  const connectionString = firstPort
    ? `${connection.host}:${firstPort.host_port}`
    : connection.host;

  return (
    <div className="lease-info-panel">
      <div className="lease-info-header">
        <span className="lease-info-title">
          <Wifi size={12} />
          Connection Info
        </span>
        <button
          onClick={onClose}
          className="lease-info-close"
          title="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
      <div className="lease-info-content">
        {/* Host */}
        <div className="lease-info-row">
          <span className="lease-info-label">Host</span>
          <span className="lease-info-string-container">
            <code className="lease-info-value">{connection.host}</code>
            <CopyButton value={connection.host} copyToClipboard={copyToClipboard} isCopied={isCopied} title="Copy host" />
          </span>
        </div>

        {/* Protocol */}
        {connection.protocol && (
          <div className="lease-info-row">
            <span className="lease-info-label">Protocol</span>
            <code className="lease-info-value">{connection.protocol}</code>
          </div>
        )}

        {/* Ports */}
        {hasPort ? (
          <div className="lease-info-row lease-info-row-complex">
            <span className="lease-info-section-label">Ports</span>
            <div className="lease-info-ports">
              {Object.entries(connection.ports!).map(([containerPort, mapping]) => {
                const hostPort = `${connection.host}:${mapping.host_port}`;
                return (
                  <div key={containerPort} className="lease-info-port-row">
                    <span className="lease-info-port-container">{containerPort}</span>
                    <span className="lease-info-port-arrow">→</span>
                    <span className="lease-info-string-container">
                      <code className="lease-info-value">{hostPort}</code>
                      <CopyButton value={hostPort} copyToClipboard={copyToClipboard} isCopied={isCopied} title="Copy host:port" />
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="lease-info-row">
            <span className="lease-info-label">Ports</span>
            <span className="lease-info-empty">No port mappings</span>
          </div>
        )}

        {/* Quick Connect */}
        {connectionString && (
          <div className="lease-info-row lease-info-connect">
            <span className="lease-info-label">Connect</span>
            <span className="lease-info-string-container">
              <code className="lease-info-value lease-info-value-highlight">{connectionString}</code>
              <CopyButton value={connectionString} copyToClipboard={copyToClipboard} isCopied={isCopied} title="Copy connection string" />
            </span>
          </div>
        )}

        {/* Metadata */}
        {hasMetadata && (
          <div className="lease-info-row lease-info-row-complex">
            <span className="lease-info-section-label">Metadata</span>
            <div className="lease-info-metadata">
              {Object.entries(connection.metadata!).map(([key, value]) => (
                <div key={key} className="lease-info-metadata-row">
                  <span className="lease-info-metadata-key">{formatKey(key)}</span>
                  <span className="lease-info-string-container">
                    <code className="lease-info-value">{value}</code>
                    <CopyButton value={value} copyToClipboard={copyToClipboard} isCopied={isCopied} />
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
