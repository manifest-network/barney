import { useState } from 'react';
import { Copy, Check, Clock, Zap, Wallet, ChevronDown, ChevronUp } from 'lucide-react';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import { truncateAddress } from '../../../utils/address';
import { formatAmount, parseBaseUnits } from '../../../utils/format';
import { DENOM_METADATA } from '../../../api/config';
import type { NetworkCreditCardProps } from './types';

export function NetworkCreditCard({ account, balances }: NetworkCreditCardProps) {
  const { copied, copyToClipboard } = useCopyToClipboard();
  const [isExpanded, setIsExpanded] = useState(false);

  // Determine status based on balance
  const hasBalance = balances.some((b) => parseBaseUnits(b.amount) > 0);
  const statusKey = hasBalance ? 'active' : 'pending';

  return (
    <div className="lease-card" data-state={statusKey}>
      {/* Collapsed Row */}
      <div className="lease-card-row" onClick={() => setIsExpanded(!isExpanded)}>
        {/* Status badge */}
        <span className="lease-card-state" data-state={statusKey}>
          <span className="lease-card-state-icon">
            <Wallet size={12} />
          </span>
          Credit
        </span>

        {/* Content */}
        <div className="lease-card-content">
          {/* Identifiers */}
          <div className="lease-card-identifiers">
            <span className="lease-card-labeled-field">
              <span className="lease-card-label">Tenant</span>
              <code className="lease-card-mono">{truncateAddress(account.tenant)}</code>
              <button
                onClick={(e) => { e.stopPropagation(); copyToClipboard(account.tenant); }}
                className="lease-card-copy-btn"
                title="Copy Tenant Address"
              >
                {copied ? <Check size={10} /> : <Copy size={10} />}
              </button>
            </span>

            <span className="lease-card-labeled-field">
              <span className="lease-card-label">Credit Address</span>
              <code className="lease-card-mono">{truncateAddress(account.creditAddress)}</code>
              <button
                onClick={(e) => { e.stopPropagation(); copyToClipboard(account.creditAddress); }}
                className="lease-card-copy-btn"
                title="Copy Credit Address"
              >
                <Copy size={10} />
              </button>
            </span>
          </div>

          {/* Separator */}
          <div className="lease-card-separator" />

          {/* Metrics */}
          <div className="lease-card-metrics">
            <span className="lease-card-cost">
              {balances.length > 0
                ? balances.map((c) => formatAmount(c.amount, c.denom)).join(', ')
                : '0 PWR'}
            </span>
            <span className="lease-card-time">
              <Zap size={11} />
              {String(account.activeLeaseCount)} active
            </span>
            <span className="lease-card-time">
              <Clock size={11} />
              {String(account.pendingLeaseCount)} pending
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
          {/* Addresses */}
          <div className="lease-card-section">
            <div className="lease-card-section-title">Addresses</div>
            <div className="lease-card-kv-list">
              <div className="lease-card-kv">
                <span className="lease-card-kv-label">Tenant Address</span>
                <code className="lease-card-kv-value">{account.tenant}</code>
                <button onClick={() => copyToClipboard(account.tenant)} className="lease-card-copy-btn" title="Copy">
                  {copied ? <Check size={10} /> : <Copy size={10} />}
                </button>
              </div>
              <div className="lease-card-kv">
                <span className="lease-card-kv-label">Credit Address</span>
                <code className="lease-card-kv-value">{account.creditAddress}</code>
                <button onClick={() => copyToClipboard(account.creditAddress)} className="lease-card-copy-btn" title="Copy">
                  <Copy size={10} />
                </button>
              </div>
            </div>
          </div>

          {/* Balances */}
          {balances.length > 0 && (
            <div className="lease-card-section">
              <div className="lease-card-section-title">Balances</div>
              <table className="lease-card-table">
                <thead>
                  <tr>
                    <th>Denom</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.map((coin) => (
                    <tr key={coin.denom}>
                      <td>{DENOM_METADATA[coin.denom]?.symbol || coin.denom}</td>
                      <td>{formatAmount(coin.amount, coin.denom)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Lease Stats */}
          <div className="lease-card-section">
            <div className="lease-card-section-title">Lease Stats</div>
            <div className="lease-card-kv-list">
              <div className="lease-card-kv">
                <span className="lease-card-kv-label">Active Leases</span>
                <span className="lease-card-kv-value">{String(account.activeLeaseCount)}</span>
              </div>
              <div className="lease-card-kv">
                <span className="lease-card-kv-label">Pending Leases</span>
                <span className="lease-card-kv-value">{String(account.pendingLeaseCount)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
