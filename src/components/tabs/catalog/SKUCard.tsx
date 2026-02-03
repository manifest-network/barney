import { Copy, Check, Loader2 } from 'lucide-react';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import { formatPrice } from '../../../api';
import type { SKUCardProps } from './types';

export function SKUCard({
  sku,
  providerAddress,
  usage,
  usageLoading,
  onEdit,
  onDeactivate,
}: SKUCardProps) {
  const { copied, copyToClipboard } = useCopyToClipboard();

  return (
    <div className="catalog-sku-card" data-status={sku.active ? 'active' : 'inactive'}>
      <div className="catalog-sku-row">
        {/* Status Badge - fixed width */}
        <span className="catalog-sku-status" data-status={sku.active ? 'active' : 'inactive'}>
          {sku.active ? 'Active' : 'Inactive'}
        </span>

        {/* Content wrapper */}
        <div className="catalog-sku-content">
          {/* Identifiers group */}
          <div className="catalog-sku-identifiers">
            <span className="catalog-sku-labeled-field" data-field="name">
              <span className="catalog-sku-label">Name</span>
              <span className="catalog-sku-value">{sku.name}</span>
            </span>

            <span className="catalog-sku-labeled-field" data-field="address">
              <span className="catalog-sku-label">Address</span>
              <code className="catalog-sku-mono">{providerAddress}</code>
              <button onClick={() => copyToClipboard(providerAddress)} className="catalog-copy-btn" title="Copy Address">
                <Copy size={10} />
              </button>
            </span>

            <span className="catalog-sku-labeled-field" data-field="uuid">
              <span className="catalog-sku-label">UUID</span>
              <code className="catalog-sku-mono">{sku.uuid}</code>
              <button onClick={() => copyToClipboard(sku.uuid)} className="catalog-copy-btn" title="Copy UUID">
                {copied ? <Check size={10} /> : <Copy size={10} />}
              </button>
            </span>
          </div>

          {/* Separator */}
          <div className="catalog-sku-separator" />

          {/* Metrics group */}
          <div className="catalog-sku-metrics">
            <span className="catalog-sku-labeled-field" data-field="price">
              <span className="catalog-sku-label">Price</span>
              <span className="catalog-sku-price">
                {formatPrice(sku.base_price.amount, sku.base_price.denom, sku.unit)}
              </span>
            </span>

            <span className="catalog-sku-labeled-field" data-field="leases">
              <span className="catalog-sku-label">Leases</span>
              <span className="catalog-sku-usage">
              {usageLoading ? (
                <Loader2 className="animate-spin" size={12} />
              ) : usage ? (
                <>
                  <span className="catalog-sku-usage-active">{usage.active}</span>
                  <span className="catalog-sku-usage-total">/ {usage.total}</span>
                </>
              ) : (
                <span className="catalog-sku-usage-total">-</span>
              )}
              </span>
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="catalog-sku-actions">
          {onEdit && (
            <button onClick={onEdit} className="btn btn-ghost btn-sm">Edit</button>
          )}
          {onDeactivate && sku.active && (
            <button onClick={onDeactivate} className="btn btn-danger btn-sm">Deactivate</button>
          )}
        </div>
      </div>
    </div>
  );
}
