import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import { CopyButton } from '../../ui/CopyButton';
import type { ProviderCardProps } from './types';

export function ProviderCard({
  provider,
  isSelected,
  onSelect,
  healthStatus,
  onEdit,
  onDeactivate,
}: ProviderCardProps) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

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
              <CopyButton value={provider.address} copyToClipboard={copyToClipboard} isCopied={isCopied} title="Copy" className="catalog-copy-btn" />
            </span>

            <span className="catalog-provider-labeled-field" data-field="uuid">
              <span className="catalog-provider-label">UUID</span>
              <code className="catalog-provider-mono">{provider.uuid}</code>
              <CopyButton value={provider.uuid} copyToClipboard={copyToClipboard} isCopied={isCopied} title="Copy" className="catalog-copy-btn" />
            </span>

            <span className="catalog-provider-labeled-field" data-field="api">
              <span className="catalog-provider-label">API</span>
              {provider.apiUrl ? (
                <>
                  <code className="catalog-provider-mono">{provider.apiUrl}</code>
                  <CopyButton value={provider.apiUrl} copyToClipboard={copyToClipboard} isCopied={isCopied} title="Copy" className="catalog-copy-btn" />
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
