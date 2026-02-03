import { Copy, Check } from 'lucide-react';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import type { ProviderCardProps } from './types';

export function ProviderCard({
  provider,
  isSelected,
  onSelect,
  healthStatus,
  onEdit,
  onDeactivate,
}: ProviderCardProps) {
  const { copied, copyToClipboard } = useCopyToClipboard();

  return (
    <div
      className={`catalog-provider-card ${isSelected ? 'selected' : ''}`}
      data-status={provider.active ? 'active' : 'inactive'}
    >
      <div className="catalog-provider-row">
        {/* Status indicator */}
        <span className="catalog-provider-status" data-status={provider.active ? 'active' : 'inactive'}>
          {provider.active ? 'Active' : 'Inactive'}
        </span>

        {/* Content */}
        <div className="catalog-provider-content">
          {/* Identity group */}
          <div className="catalog-provider-identifiers">
            <span className="catalog-provider-labeled-field" data-field="address">
              <span className="catalog-provider-label">Address</span>
              <code className="catalog-provider-mono">{provider.address}</code>
              <button onClick={() => copyToClipboard(provider.address)} className="catalog-copy-btn" title="Copy">
                {copied ? <Check size={10} /> : <Copy size={10} />}
              </button>
            </span>

            <span className="catalog-provider-labeled-field" data-field="uuid">
              <span className="catalog-provider-label">UUID</span>
              <code className="catalog-provider-mono">{provider.uuid}</code>
              <button onClick={() => copyToClipboard(provider.uuid)} className="catalog-copy-btn" title="Copy">
                <Copy size={10} />
              </button>
            </span>

            <span className="catalog-provider-labeled-field" data-field="api">
              <span className="catalog-provider-label">API</span>
              {provider.api_url ? (
                <>
                  <code className="catalog-provider-mono">{provider.api_url}</code>
                  <button onClick={() => copyToClipboard(provider.api_url)} className="catalog-copy-btn" title="Copy">
                    <Copy size={10} />
                  </button>
                  {healthStatus && (
                    <span className="catalog-provider-health" data-status={healthStatus} title={healthStatus} />
                  )}
                </>
              ) : (
                <span className="catalog-provider-no-api">Not configured</span>
              )}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="catalog-provider-actions">
          <button onClick={onSelect} className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-ghost'}`}>
            {isSelected ? 'Selected' : 'Filter SKUs'}
          </button>
          {onEdit && (
            <button onClick={onEdit} className="btn btn-ghost btn-sm">Edit</button>
          )}
          {onDeactivate && provider.active && (
            <button onClick={onDeactivate} className="btn btn-danger btn-sm">Deactivate</button>
          )}
        </div>
      </div>
    </div>
  );
}
