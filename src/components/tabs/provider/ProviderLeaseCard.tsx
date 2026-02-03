import { useState } from 'react';
import { Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import { formatCostPerHour } from '../../../utils/pricing';
import { formatPrice } from '../../../api/config';
import { formatDate } from '../../../utils/format';
import type { ProviderLeaseCardProps } from './types';

export function ProviderLeaseCard({
  lease,
  type,
  getSKU,
  onAcknowledge,
  onReject,
  withdrawable = [],
  onWithdraw,
  onClose,
  txLoading,
  isSelected,
  onToggleSelect,
}: ProviderLeaseCardProps) {
  const { copied, copyToClipboard } = useCopyToClipboard();
  const [isExpanded, setIsExpanded] = useState(false);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [closeReason, setCloseReason] = useState('');

  const hourlyRate = () => formatCostPerHour(lease.items);

  return (
    <div
      className={`provider-lease-card ${isSelected ? 'selected' : ''}`}
      data-type={type}
    >
      {/* Collapsed Row */}
      <div className="provider-lease-row" onClick={() => setIsExpanded(!isExpanded)}>
        {/* Checkbox cell */}
        <div className="provider-lease-checkbox-cell" onClick={(e) => e.stopPropagation()}>
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={isSelected || false}
              onChange={onToggleSelect}
              className="provider-lease-checkbox"
            />
          )}
        </div>

        {/* Type badge */}
        <span className="provider-lease-type" data-type={type}>
          {type === 'pending' ? 'PENDING' : 'ACTIVE'}
        </span>

        {/* Content */}
        <div className="provider-lease-content">
          <div className="provider-lease-identifiers">
            <span className="provider-lease-field">
              <span className="provider-lease-label">Lease</span>
              <code className="provider-lease-mono">{lease.uuid}</code>
              <button
                onClick={(e) => { e.stopPropagation(); copyToClipboard(lease.uuid); }}
                className="provider-lease-copy"
                title="Copy Lease UUID"
              >
                {copied ? <Check size={10} /> : <Copy size={10} />}
              </button>
            </span>
            <span className="provider-lease-field">
              <span className="provider-lease-label">Tenant</span>
              <code className="provider-lease-mono">{lease.tenant}</code>
              <button
                onClick={(e) => { e.stopPropagation(); copyToClipboard(lease.tenant); }}
                className="provider-lease-copy"
                title="Copy Tenant"
              >
                {copied ? <Check size={10} /> : <Copy size={10} />}
              </button>
            </span>
          </div>

          <div className="provider-lease-separator" />

          <div className="provider-lease-metrics">
            {type === 'active' && (
              <span className="provider-lease-metric" data-type="withdrawable">
                <span className="provider-lease-metric-value">
                  {withdrawable.length > 0
                    ? withdrawable.map((c) => formatPrice(c.amount, c.denom)).join(', ')
                    : '0'}
                </span>
                <span className="provider-lease-metric-label">Withdrawable</span>
              </span>
            )}
            <span className="provider-lease-metric" data-type="rate">
              <span className="provider-lease-metric-value">{hourlyRate()}</span>
              <span className="provider-lease-metric-label">Rate</span>
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="provider-lease-actions" onClick={(e) => e.stopPropagation()}>
          {type === 'pending' && (
            <>
              <button
                onClick={() => onAcknowledge?.()}
                disabled={txLoading}
                className="btn btn-success btn-sm"
              >
                Acknowledge
              </button>
              <button
                onClick={() => setShowRejectForm(!showRejectForm)}
                disabled={txLoading}
                className="btn btn-danger btn-sm"
              >
                Reject
              </button>
            </>
          )}
          {type === 'active' && (
            <>
              <button
                onClick={() => onWithdraw?.()}
                disabled={txLoading || withdrawable.length === 0}
                className="btn btn-success btn-sm"
              >
                Withdraw
              </button>
              <button
                onClick={() => setShowCloseForm(!showCloseForm)}
                disabled={txLoading}
                className="btn btn-ghost btn-sm"
              >
                Close
              </button>
            </>
          )}
        </div>

        {/* Expand toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
          className={`provider-lease-expand ${isExpanded ? 'expanded' : ''}`}
        >
          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* Reject Form (inline) */}
      {showRejectForm && type === 'pending' && (
        <div className="provider-lease-form">
          <label className="provider-lease-form-label">Rejection Reason (optional)</label>
          <div className="provider-lease-form-row">
            <input
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g., Insufficient capacity"
              maxLength={256}
              className="provider-lease-form-input"
              disabled={txLoading}
            />
            <button
              onClick={() => {
                onReject?.(rejectReason);
                setShowRejectForm(false);
                setRejectReason('');
              }}
              disabled={txLoading}
              className="btn btn-danger btn-sm"
            >
              Confirm
            </button>
            <button
              onClick={() => { setShowRejectForm(false); setRejectReason(''); }}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Close Form (inline) */}
      {showCloseForm && type === 'active' && (
        <div className="provider-lease-form">
          <label className="provider-lease-form-label">Closure Reason (optional)</label>
          <div className="provider-lease-form-row">
            <input
              type="text"
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              placeholder="e.g., Resource decommissioned"
              maxLength={256}
              className="provider-lease-form-input"
              disabled={txLoading}
            />
            <button
              onClick={() => {
                onClose?.(closeReason || undefined);
                setShowCloseForm(false);
                setCloseReason('');
              }}
              disabled={txLoading}
              className="btn btn-ghost btn-sm"
            >
              Confirm
            </button>
            <button
              onClick={() => { setShowCloseForm(false); setCloseReason(''); }}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Expanded Details */}
      {isExpanded && (
        <div className="provider-lease-expanded">
          <div className="provider-lease-details">
            <div className="provider-lease-detail">
              <span className="provider-lease-detail-label">Created</span>
              <span className="provider-lease-detail-value">{formatDate(lease.createdAt)}</span>
            </div>
            {type === 'active' && lease.acknowledgedAt && (
              <div className="provider-lease-detail">
                <span className="provider-lease-detail-label">Active Since</span>
                <span className="provider-lease-detail-value">{formatDate(lease.acknowledgedAt)}</span>
              </div>
            )}
          </div>

          <div className="provider-lease-items">
            <div className="provider-lease-items-title">Requested Items</div>
            {lease.items.map((item) => {
              const sku = getSKU(item.skuUuid);
              return (
                <div key={`${lease.uuid}-${item.skuUuid}`} className="provider-lease-item">
                  <span className="provider-lease-item-name">
                    {sku?.name || item.skuUuid} × {String(item.quantity)}
                  </span>
                  <span className="provider-lease-item-price">
                    {formatPrice(item.lockedPrice.amount, item.lockedPrice.denom)}/sec
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
