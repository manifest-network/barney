/**
 * Lease card component with expandable details and actions.
 */

import { useState } from 'react';
import { useChain } from '@cosmos-kit/react';
import { ChevronDown, ChevronUp, Clock, X, Zap, MinusCircle, XCircle } from 'lucide-react';
import { LeaseState } from '../../../api/billing';
import { SECONDS_PER_HOUR } from '../../../config/constants';
import { CHAIN_NAME } from '../../../config/chain';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import { formatDate, formatRelativeTime, formatDuration, fromBaseUnits } from '../../../utils/format';
import { LEASE_STATE_LABELS, LEASE_STATE_TO_FILTER, type LeaseFilterState } from '../../../utils/leaseState';
import { DENOM_METADATA } from '../../../api/config';
import { formatCostPerHour } from '../../../utils/pricing';
import {
  createSignMessage,
  createAuthToken,
  getLeaseConnectionInfo,
  type LeaseConnectionResponse,
} from '../../../api/provider-api';
import { validateSignMessage } from './utils';
import { CopyButton } from './CopyButton';
import { ConnectionInfoPanel } from './ConnectionInfoPanel';
import type { LeaseCardProps } from './types';

// State icons
const STATE_ICONS: Record<LeaseFilterState, React.ReactNode> = {
  all: null,
  pending: <Clock size={12} />,
  active: <Zap size={12} />,
  closed: <MinusCircle size={12} />,
  rejected: <XCircle size={12} />,
};

export function LeaseCard({
  lease,
  getSKU,
  getProvider,
  onCancel,
  onClose,
  txLoading,
  tenantAddress,
  isSelected,
  onToggleSelect,
}: LeaseCardProps) {
  const { signArbitrary } = useChain(CHAIN_NAME);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const [isExpanded, setIsExpanded] = useState(false);
  const [leaseInfo, setLeaseInfo] = useState<LeaseConnectionResponse | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [closeReason, setCloseReason] = useState('');

  const provider = getProvider(lease.providerUuid);
  const stateKey = LEASE_STATE_TO_FILTER[lease.state];
  const canSelect = lease.state === LeaseState.LEASE_STATE_PENDING || lease.state === LeaseState.LEASE_STATE_ACTIVE;
  const isPending = lease.state === LeaseState.LEASE_STATE_PENDING;
  const isActive = lease.state === LeaseState.LEASE_STATE_ACTIVE;

  const costPerHour = formatCostPerHour(lease.items);

  const handleGetConnectionInfo = async () => {
    // Toggle: if already showing, close it
    if (leaseInfo) {
      setLeaseInfo(null);
      return;
    }

    if (!tenantAddress || !provider?.apiUrl) {
      setConnectionError('Missing tenant address or provider API URL');
      return;
    }

    try {
      setConnectionLoading(true);
      setConnectionError(null);

      const timestamp = Math.floor(Date.now() / 1000);
      const message = createSignMessage(tenantAddress, lease.uuid, timestamp);

      if (!validateSignMessage(message, tenantAddress)) {
        throw new Error('Invalid signature message format');
      }

      const signResult = await signArbitrary(tenantAddress, message);

      const authToken = createAuthToken(
        tenantAddress,
        lease.uuid,
        timestamp,
        signResult.pub_key.value,
        signResult.signature
      );

      const info = await getLeaseConnectionInfo(provider.apiUrl, lease.uuid, authToken);
      setLeaseInfo(info);
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : 'Failed to get connection info');
    } finally {
      setConnectionLoading(false);
    }
  };

  return (
    <div className={`lease-card ${isSelected ? 'selected' : ''}`} data-state={stateKey}>
      {/* === COLLAPSED VIEW === */}
      <div className="lease-card-row" onClick={() => setIsExpanded(!isExpanded)}>
        {/* Checkbox for batch selection - always reserve space */}
        <div className="lease-card-checkbox-cell" onClick={(e) => e.stopPropagation()}>
          {canSelect && onToggleSelect ? (
            <input
              type="checkbox"
              checked={isSelected || false}
              onChange={onToggleSelect}
              className="lease-card-checkbox"
            />
          ) : null}
        </div>

        {/* State badge - fixed width */}
        <span className="lease-card-state" data-state={stateKey}>
          <span className="lease-card-state-icon">{STATE_ICONS[stateKey]}</span>
          {LEASE_STATE_LABELS[lease.state]}
        </span>

        {/* Middle content (identifiers + separator + metrics) */}
        <div className="lease-card-content">
          {/* Identifiers group */}
          <div className="lease-card-identifiers">
            <span className="lease-card-labeled-field" data-field="lease">
              <span className="lease-card-label">Lease</span>
              <code className="lease-card-mono">{lease.uuid}</code>
              <CopyButton value={lease.uuid} copyToClipboard={copyToClipboard} isCopied={isCopied} title="Copy Lease UUID" stopPropagation />
            </span>

            <span className="lease-card-labeled-field" data-field="provider">
              <span className="lease-card-label">Provider</span>
              <code className="lease-card-mono">{provider?.address || lease.providerUuid}</code>
              <CopyButton value={provider?.address || lease.providerUuid} copyToClipboard={copyToClipboard} isCopied={isCopied} title="Copy Provider Address" stopPropagation />
            </span>
          </div>

          {/* Separator */}
          <div className="lease-card-separator" />

          {/* Metrics group */}
          <div className="lease-card-metrics">
            <span className="lease-card-labeled-field" data-field="cost">
              <span className="lease-card-label">Cost</span>
              <span className="lease-card-cost">{costPerHour}</span>
            </span>
            <span className="lease-card-labeled-field" data-field="created">
              <span className="lease-card-label">Created</span>
              <span className="lease-card-time">
                <Clock size={11} />
                {formatRelativeTime(lease.createdAt)}
              </span>
            </span>
          </div>
        </div>

        {/* Actions (contextual) */}
        <div className="lease-card-actions" onClick={(e) => e.stopPropagation()}>
          {isPending && (
            <button
              onClick={() => onCancel(lease.uuid)}
              disabled={txLoading}
              className="btn btn-danger btn-sm"
            >
              Cancel
            </button>
          )}
          {isActive && (
            <>
              <button
                onClick={handleGetConnectionInfo}
                disabled={connectionLoading || !provider?.apiUrl}
                className="btn btn-primary btn-sm"
                title={!provider?.apiUrl ? 'Provider has no API URL' : undefined}
              >
                {connectionLoading ? '...' : 'Get Info'}
              </button>
              <button
                onClick={() => setShowCloseForm(!showCloseForm)}
                disabled={txLoading}
                className="btn btn-danger btn-sm"
              >
                Close
              </button>
            </>
          )}
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

      {/* Connection error (inline) */}
      {connectionError && (
        <div className="lease-card-error">
          <span>{connectionError}</span>
          <button onClick={() => setConnectionError(null)} className="btn btn-ghost btn-xs">
            <X size={12} />
          </button>
        </div>
      )}

      {/* Close form (inline) */}
      {showCloseForm && (
        <div className="lease-card-inline-form">
          <input
            type="text"
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
            placeholder="Reason (optional)"
            maxLength={256}
            className="input input-sm"
            disabled={txLoading}
          />
          <button
            onClick={() => {
              onClose(lease.uuid, closeReason || undefined);
              setShowCloseForm(false);
              setCloseReason('');
            }}
            disabled={txLoading}
            className="btn btn-warning btn-sm"
          >
            Confirm
          </button>
          <button
            onClick={() => { setShowCloseForm(false); setCloseReason(''); }}
            className="btn btn-ghost btn-sm"
          >
            ×
          </button>
        </div>
      )}

      {/* Connection Info Panel (inline) */}
      {leaseInfo && (
        <ConnectionInfoPanel
          info={leaseInfo}
          copyToClipboard={copyToClipboard}
          isCopied={isCopied}
          onClose={() => setLeaseInfo(null)}
        />
      )}

      {/* === EXPANDED VIEW === */}
      {isExpanded && (
        <LeaseCardExpanded
          lease={lease}
          getSKU={getSKU}
          copyToClipboard={copyToClipboard}
          isCopied={isCopied}
        />
      )}
    </div>
  );
}

/**
 * Expanded details section of the lease card.
 */
function LeaseCardExpanded({
  lease,
  getSKU,
  copyToClipboard,
  isCopied,
}: {
  lease: LeaseCardProps['lease'];
  getSKU: LeaseCardProps['getSKU'];
  copyToClipboard: (text: string) => void;
  isCopied: (text: string) => boolean;
}) {
  return (
    <div className="lease-card-expanded">
      {/* Identifiers */}
      <div className="lease-card-section">
        <div className="lease-card-section-title">Identifiers</div>
        <div className="lease-card-kv-list">
          <div className="lease-card-kv">
            <span className="lease-card-kv-label">Lease UUID</span>
            <code className="lease-card-kv-value">{lease.uuid}</code>
            <CopyButton value={lease.uuid} copyToClipboard={copyToClipboard} isCopied={isCopied} />
          </div>
          <div className="lease-card-kv">
            <span className="lease-card-kv-label">Provider UUID</span>
            <code className="lease-card-kv-value">{lease.providerUuid}</code>
            <CopyButton value={lease.providerUuid} copyToClipboard={copyToClipboard} isCopied={isCopied} />
          </div>
          {lease.metaHash && lease.metaHash.length > 0 && (
            <div className="lease-card-kv">
              <span className="lease-card-kv-label">Meta Hash</span>
              <code className="lease-card-kv-value">{Array.from(lease.metaHash).map(b => b.toString(16).padStart(2, '0')).join('')}</code>
              <CopyButton value={Array.from(lease.metaHash).map(b => b.toString(16).padStart(2, '0')).join('')} copyToClipboard={copyToClipboard} isCopied={isCopied} />
            </div>
          )}
          {lease.minLeaseDurationAtCreation > 0n && (
            <div className="lease-card-kv">
              <span className="lease-card-kv-label">Min Duration</span>
              <span className="lease-card-kv-value">{formatDuration(lease.minLeaseDurationAtCreation)}</span>
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
            {lease.items.map((item) => {
              const sku = getSKU(item.skuUuid);
              const pricePerHour = fromBaseUnits(item.lockedPrice.amount, item.lockedPrice.denom) * SECONDS_PER_HOUR;
              const symbol = DENOM_METADATA[item.lockedPrice.denom]?.symbol || item.lockedPrice.denom;
              return (
                <tr key={`${lease.uuid}-item-${item.skuUuid}`}>
                  <td>{sku?.name || item.skuUuid.slice(0, 12)}</td>
                  <td>{String(item.quantity)}</td>
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
            <span className="lease-card-timeline-date">{formatDate(lease.createdAt)}</span>
          </div>
          {lease.acknowledgedAt && (
            <div className="lease-card-timeline-event">
              <span className="lease-card-timeline-dot" data-type="ack" />
              <span className="lease-card-timeline-label">Acknowledged</span>
              <span className="lease-card-timeline-date">{formatDate(lease.acknowledgedAt)}</span>
            </div>
          )}
          {lease.closedAt && (
            <div className="lease-card-timeline-event">
              <span className="lease-card-timeline-dot" data-type="closed" />
              <span className="lease-card-timeline-label">Closed</span>
              <span className="lease-card-timeline-date">{formatDate(lease.closedAt)}</span>
              {lease.closureReason && (
                <span className="lease-card-timeline-reason">{lease.closureReason}</span>
              )}
            </div>
          )}
          {lease.rejectedAt && (
            <div className="lease-card-timeline-event">
              <span className="lease-card-timeline-dot" data-type="rejected" />
              <span className="lease-card-timeline-label">Rejected</span>
              <span className="lease-card-timeline-date">{formatDate(lease.rejectedAt)}</span>
              {lease.rejectionReason && (
                <span className="lease-card-timeline-reason">{lease.rejectionReason}</span>
              )}
            </div>
          )}
          {lease.expiredAt && (
            <div className="lease-card-timeline-event">
              <span className="lease-card-timeline-dot" data-type="expired" />
              <span className="lease-card-timeline-label">Expired</span>
              <span className="lease-card-timeline-date">{formatDate(lease.expiredAt)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
