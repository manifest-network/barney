import { useState } from 'react';
import { Copy, Check, Clock, Zap, ChevronDown, ChevronUp } from 'lucide-react';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import { truncateAddress } from '../../../utils/address';
import { formatDate, formatDuration, formatRelativeTime, fromBaseUnits } from '../../../utils/format';
import { DENOM_METADATA } from '../../../api/config';
import { SECONDS_PER_HOUR } from '../../../config/constants';
import { LEASE_STATE_LABELS, LEASE_STATE_TO_FILTER } from '../../../utils/leaseState';
import { formatCostPerHour } from '../../../utils/pricing';
import type { NetworkLeaseCardProps } from './types';

export function NetworkLeaseCard({ lease, getProvider, getSKU }: NetworkLeaseCardProps) {
  const { copied, copyToClipboard } = useCopyToClipboard();
  const [isExpanded, setIsExpanded] = useState(false);
  const provider = getProvider(lease.provider_uuid);
  const stateKey = LEASE_STATE_TO_FILTER[lease.state];

  const costPerHour = formatCostPerHour(lease.items);

  return (
    <div className="lease-card" data-state={stateKey}>
      {/* Collapsed Row */}
      <div className="lease-card-row" onClick={() => setIsExpanded(!isExpanded)}>
        {/* State badge */}
        <span className="lease-card-state" data-state={stateKey}>
          <span className="lease-card-state-icon">
            {stateKey === 'pending' && <Clock size={12} />}
            {stateKey === 'active' && <Zap size={12} />}
          </span>
          {LEASE_STATE_LABELS[lease.state]}
        </span>

        {/* Content */}
        <div className="lease-card-content">
          {/* Identifiers */}
          <div className="lease-card-identifiers">
            <span className="lease-card-labeled-field">
              <span className="lease-card-label">Lease</span>
              <code className="lease-card-mono">{truncateAddress(lease.uuid, 8, 6)}</code>
              <button
                onClick={(e) => { e.stopPropagation(); copyToClipboard(lease.uuid); }}
                className="lease-card-copy-btn"
                title="Copy Lease UUID"
              >
                {copied ? <Check size={10} /> : <Copy size={10} />}
              </button>
            </span>

            <span className="lease-card-labeled-field">
              <span className="lease-card-label">Tenant</span>
              <code className="lease-card-mono">{truncateAddress(lease.tenant)}</code>
              <button
                onClick={(e) => { e.stopPropagation(); copyToClipboard(lease.tenant); }}
                className="lease-card-copy-btn"
                title="Copy Tenant Address"
              >
                <Copy size={10} />
              </button>
            </span>

            <span className="lease-card-labeled-field">
              <span className="lease-card-label">Provider</span>
              <code className="lease-card-mono">{truncateAddress(provider?.address || lease.provider_uuid)}</code>
              <button
                onClick={(e) => { e.stopPropagation(); copyToClipboard(provider?.address || lease.provider_uuid); }}
                className="lease-card-copy-btn"
                title="Copy Provider Address"
              >
                <Copy size={10} />
              </button>
            </span>
          </div>

          {/* Separator */}
          <div className="lease-card-separator" />

          {/* Metrics */}
          <div className="lease-card-metrics">
            <span className="lease-card-cost">{costPerHour}</span>
            <span className="lease-card-time">
              <Clock size={11} />
              {formatRelativeTime(lease.created_at)}
            </span>
          </div>
        </div>

        {/* Expand toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
          className={`lease-card-expand ${isExpanded ? 'expanded' : ''}`}
          title={isExpanded ? 'Collapse' : 'Expand'}
        >
          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="lease-card-expanded">
          {/* Identifiers */}
          <div className="lease-card-section">
            <div className="lease-card-section-title">Identifiers</div>
            <div className="lease-card-kv-list">
              <div className="lease-card-kv">
                <span className="lease-card-kv-label">Lease UUID</span>
                <code className="lease-card-kv-value">{lease.uuid}</code>
                <button onClick={() => copyToClipboard(lease.uuid)} className="lease-card-copy-btn" title="Copy">
                  <Copy size={10} />
                </button>
              </div>
              <div className="lease-card-kv">
                <span className="lease-card-kv-label">Tenant</span>
                <code className="lease-card-kv-value">{lease.tenant}</code>
                <button onClick={() => copyToClipboard(lease.tenant)} className="lease-card-copy-btn" title="Copy">
                  <Copy size={10} />
                </button>
              </div>
              <div className="lease-card-kv">
                <span className="lease-card-kv-label">Provider UUID</span>
                <code className="lease-card-kv-value">{lease.provider_uuid}</code>
                <button onClick={() => copyToClipboard(lease.provider_uuid)} className="lease-card-copy-btn" title="Copy">
                  <Copy size={10} />
                </button>
              </div>
              {provider?.address && (
                <div className="lease-card-kv">
                  <span className="lease-card-kv-label">Provider Address</span>
                  <code className="lease-card-kv-value">{provider.address}</code>
                  <button onClick={() => copyToClipboard(provider.address)} className="lease-card-copy-btn" title="Copy">
                    <Copy size={10} />
                  </button>
                </div>
              )}
              {lease.meta_hash && (
                <div className="lease-card-kv">
                  <span className="lease-card-kv-label">Meta Hash</span>
                  <code className="lease-card-kv-value">{lease.meta_hash}</code>
                  <button onClick={() => copyToClipboard(lease.meta_hash!)} className="lease-card-copy-btn" title="Copy">
                    <Copy size={10} />
                  </button>
                </div>
              )}
              {lease.min_lease_duration_at_creation && (
                <div className="lease-card-kv">
                  <span className="lease-card-kv-label">Min Duration</span>
                  <span className="lease-card-kv-value">{formatDuration(lease.min_lease_duration_at_creation)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Items */}
          <div className="lease-card-section">
            <div className="lease-card-section-title">Items ({lease.items.length})</div>
            <table className="lease-card-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Qty</th>
                  <th>Price</th>
                </tr>
              </thead>
              <tbody>
                {lease.items.map((item, idx) => {
                  const sku = getSKU(item.sku_uuid);
                  const pricePerHour = fromBaseUnits(item.locked_price.amount, item.locked_price.denom) * SECONDS_PER_HOUR;
                  const symbol = DENOM_METADATA[item.locked_price.denom]?.symbol || item.locked_price.denom;
                  return (
                    <tr key={`${lease.uuid}-item-${item.sku_uuid}-${idx}`}>
                      <td>{sku?.name || item.sku_uuid.slice(0, 12)}</td>
                      <td>{item.quantity}</td>
                      <td>{pricePerHour.toFixed(4)} {symbol}/hr</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Timeline */}
          <div className="lease-card-section">
            <div className="lease-card-section-title">Timeline</div>
            <div className="lease-card-timeline">
              <div className="lease-card-timeline-event">
                <span className="lease-card-timeline-dot" data-type="created" />
                <span className="lease-card-timeline-label">Created</span>
                <span className="lease-card-timeline-date">{formatDate(lease.created_at)}</span>
              </div>
              {lease.acknowledged_at && (
                <div className="lease-card-timeline-event">
                  <span className="lease-card-timeline-dot" data-type="ack" />
                  <span className="lease-card-timeline-label">Acknowledged</span>
                  <span className="lease-card-timeline-date">{formatDate(lease.acknowledged_at)}</span>
                </div>
              )}
              {lease.closed_at && (
                <div className="lease-card-timeline-event">
                  <span className="lease-card-timeline-dot" data-type="closed" />
                  <span className="lease-card-timeline-label">Closed</span>
                  <span className="lease-card-timeline-date">{formatDate(lease.closed_at)}</span>
                  {lease.closure_reason && (
                    <span className="lease-card-timeline-reason">{lease.closure_reason}</span>
                  )}
                </div>
              )}
              {lease.rejected_at && (
                <div className="lease-card-timeline-event">
                  <span className="lease-card-timeline-dot" data-type="rejected" />
                  <span className="lease-card-timeline-label">Rejected</span>
                  <span className="lease-card-timeline-date">{formatDate(lease.rejected_at)}</span>
                  {lease.rejection_reason && (
                    <span className="lease-card-timeline-reason">{lease.rejection_reason}</span>
                  )}
                </div>
              )}
              {lease.expired_at && (
                <div className="lease-card-timeline-event">
                  <span className="lease-card-timeline-dot" data-type="expired" />
                  <span className="lease-card-timeline-label">Expired</span>
                  <span className="lease-card-timeline-date">{formatDate(lease.expired_at)}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
