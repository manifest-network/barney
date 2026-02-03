import { useState, useEffect, useCallback } from 'react';
import { Link, ShieldX, Globe, Copy, Check, Clock, Zap, Package, Users, ChevronDown, ChevronUp, Wallet } from 'lucide-react';
import {
  LeaseState,
  leaseStateToString,
  leaseStateFromString,
  getAllLeases,
  getAllCredits,
  getBillingParams,
  type Lease,
  type CreditAccount,
  type PaginatedLeasesResponse,
  type PaginatedCreditsResponse,
} from '../../api/billing';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { logError } from '../../utils/errors';
import { formatAmount, formatDate, formatDuration, formatRelativeTime, parseBaseUnits, fromBaseUnits } from '../../utils/format';
import { truncateAddress } from '../../utils/address';
import { DENOM_METADATA } from '../../api/config';
import { SECONDS_PER_HOUR } from '../../config/constants';
import { getProviders, getSKUs, type Provider, type SKU } from '../../api/sku';
import type { Coin } from '../../api/bank';
import { useAutoRefreshContext } from '../../contexts/AutoRefreshContext';
import { useAutoRefreshTab } from '../../hooks/useAutoRefreshTab';
import { LEASE_STATE_LABELS, LEASE_STATE_TO_FILTER } from '../../utils/leaseState';
import { formatCostPerHour } from '../../utils/pricing';
import { EmptyState } from '../ui/EmptyState';
import { ErrorBanner } from '../ui/ErrorBanner';
import { SkeletonCard } from '../ui/SkeletonCard';
import { Pagination } from '../ui/Pagination';

const PAGE_SIZE = 10;

interface NetworkTabProps {
  isConnected: boolean;
  address?: string;
  onConnect: () => void;
}

type ViewMode = 'leases' | 'credits';

export function NetworkTab({ isConnected, address, onConnect }: NetworkTabProps) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // View mode
  const [viewMode, setViewMode] = useState<ViewMode>('leases');

  // Leases data
  const [leasesResponse, setLeasesResponse] = useState<PaginatedLeasesResponse | null>(null);
  const [leaseStateFilter, setLeaseStateFilter] = useState<LeaseState | 'all'>('all');
  const [leaseOffset, setLeaseOffset] = useState(0);

  // Credits data
  const [creditsResponse, setCreditsResponse] = useState<PaginatedCreditsResponse | null>(null);
  const [creditOffset, setCreditOffset] = useState(0);

  // Reference data
  const [providers, setProviders] = useState<Provider[]>([]);
  const [skus, setSKUs] = useState<SKU[]>([]);

  // Network stats
  const [stats, setStats] = useState<{
    totalLeases: number;
    pendingLeases: number;
    activeLeases: number;
    closedLeases: number;
    totalProviders: number;
    totalSKUs: number;
  } | null>(null);

  // Check if user is admin
  useEffect(() => {
    const checkAdmin = async () => {
      if (!address) {
        setIsAdmin(false);
        return;
      }

      try {
        const params = await getBillingParams();
        setIsAdmin(params.allowed_list.includes(address));
      } catch {
        setIsAdmin(false);
      }
    };

    checkAdmin();
  }, [address]);

  // Fetch reference data (providers, SKUs) and stats
  const fetchReferenceData = useCallback(async () => {
    try {
      const [providersData, skusData] = await Promise.all([
        getProviders(),
        getSKUs(),
      ]);

      setProviders(providersData);
      setSKUs(skusData);

      // Fetch stats by getting all leases (just for counts)
      const [pending, active, closed] = await Promise.all([
        getAllLeases({ stateFilter: LeaseState.LEASE_STATE_PENDING, limit: 1 }),
        getAllLeases({ stateFilter: LeaseState.LEASE_STATE_ACTIVE, limit: 1 }),
        getAllLeases({ stateFilter: LeaseState.LEASE_STATE_CLOSED, limit: 1 }),
      ]);

      setStats({
        totalLeases: parseInt(pending.pagination?.total || '0', 10) +
                     parseInt(active.pagination?.total || '0', 10) +
                     parseInt(closed.pagination?.total || '0', 10),
        pendingLeases: parseInt(pending.pagination?.total || '0', 10),
        activeLeases: parseInt(active.pagination?.total || '0', 10),
        closedLeases: parseInt(closed.pagination?.total || '0', 10),
        totalProviders: providersData.length,
        totalSKUs: skusData.length,
      });
    } catch (err) {
      logError('NetworkTab.fetchReferenceData', err);
    }
  }, []);

  // Fetch leases
  const fetchLeases = useCallback(async (showLoading = true) => {
    if (showLoading) {
      setLoading(true);
    }
    setError(null);

    try {
      const response = await getAllLeases({
        stateFilter: leaseStateFilter === 'all' ? undefined : leaseStateFilter,
        limit: PAGE_SIZE,
        offset: leaseOffset,
      });

      setLeasesResponse(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch leases');
    } finally {
      setLoading(false);
    }
  }, [leaseStateFilter, leaseOffset]);

  // Fetch credits
  const fetchCredits = useCallback(async (showLoading = true) => {
    if (showLoading) {
      setLoading(true);
    }
    setError(null);

    try {
      const response = await getAllCredits({
        limit: PAGE_SIZE,
        offset: creditOffset,
      });

      setCreditsResponse(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch credits');
    } finally {
      setLoading(false);
    }
  }, [creditOffset]);

  // Combined fetch for auto-refresh
  const fetchCurrentView = useCallback(async () => {
    await fetchReferenceData();
    if (viewMode === 'leases') {
      await fetchLeases(false);
    } else {
      await fetchCredits(false);
    }
  }, [fetchReferenceData, viewMode, fetchLeases, fetchCredits]);

  const { refresh } = useAutoRefreshContext();
  useAutoRefreshTab(fetchCurrentView, isAdmin);

  // Initial data load
  useEffect(() => {
    if (isAdmin) {
      fetchReferenceData();
    }
  }, [isAdmin, fetchReferenceData]);

  // Fetch data for the active view when dependencies change
  useEffect(() => {
    if (!isAdmin) return;

    if (viewMode === 'leases') {
      fetchLeases(true);
    } else {
      fetchCredits(true);
    }
  }, [isAdmin, viewMode, fetchLeases, fetchCredits]);

  // Reset offsets when view mode changes
  useEffect(() => {
    setLeaseOffset(0);
    setCreditOffset(0);
  }, [viewMode]);

  // Reset lease offset when filter changes
  useEffect(() => {
    setLeaseOffset(0);
  }, [leaseStateFilter]);

  const getProvider = (uuid: string) => providers.find((p) => p.uuid === uuid);
  const getSKU = (uuid: string) => skus.find((s) => s.uuid === uuid);

  if (!isConnected) {
    return (
      <EmptyState
        icon={Link}
        title="Admin Access Required"
        description="Connect your wallet to access the network dashboard"
        action={{ label: 'Connect Wallet', onClick: onConnect }}
      />
    );
  }

  if (!isAdmin) {
    return (
      <EmptyState
        icon={ShieldX}
        title="Access Denied"
        description="Your wallet is not in the billing module allowed list."
      />
    );
  }

  const totalLeasePages = Math.ceil(
    parseInt(leasesResponse?.pagination?.total || '0', 10) / PAGE_SIZE
  );
  const currentLeasePage = Math.floor(leaseOffset / PAGE_SIZE) + 1;

  const totalCreditPages = Math.ceil(
    parseInt(creditsResponse?.pagination?.total || '0', 10) / PAGE_SIZE
  );
  const currentCreditPage = Math.floor(creditOffset / PAGE_SIZE) + 1;

  const leases = leasesResponse?.leases || [];
  const credits = creditsResponse?.credit_accounts || [];

  return (
    <div className="space-y-4">
      {/* Admin Badge */}
      <div className="catalog-admin-banner" data-role="admin">
        <div className="catalog-admin-icon">
          <Globe size={16} />
        </div>
        <div className="catalog-admin-info">
          <div className="catalog-admin-title">Network Admin Dashboard</div>
          <div className="catalog-admin-desc">
            View all network leases and credit accounts
          </div>
        </div>
      </div>

      {/* Stats Row */}
      {stats && (
        <div className="network-stats-row">
          <div className="network-stat" data-type="pending">
            <div className="network-stat-icon">
              <Clock size={16} />
            </div>
            <div className="network-stat-content">
              <span className="network-stat-value">{stats.pendingLeases}</span>
              <span className="network-stat-label">Pending</span>
            </div>
          </div>
          <div className="network-stat" data-type="active">
            <div className="network-stat-icon">
              <Zap size={16} />
            </div>
            <div className="network-stat-content">
              <span className="network-stat-value">{stats.activeLeases}</span>
              <span className="network-stat-label">Active</span>
            </div>
          </div>
          <div className="network-stat" data-type="closed">
            <div className="network-stat-icon">
              <Check size={16} />
            </div>
            <div className="network-stat-content">
              <span className="network-stat-value">{stats.closedLeases}</span>
              <span className="network-stat-label">Closed</span>
            </div>
          </div>
          <div className="network-stat" data-type="providers">
            <div className="network-stat-icon">
              <Users size={16} />
            </div>
            <div className="network-stat-content">
              <span className="network-stat-value">{stats.totalProviders}</span>
              <span className="network-stat-label">Providers</span>
            </div>
          </div>
          <div className="network-stat" data-type="skus">
            <div className="network-stat-icon">
              <Package size={16} />
            </div>
            <div className="network-stat-content">
              <span className="network-stat-value">{stats.totalSKUs}</span>
              <span className="network-stat-label">SKUs</span>
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && <ErrorBanner error={error} onRetry={refresh} />}

      {/* View Mode Tabs */}
      <div className="filter-tabs">
        <button
          onClick={() => setViewMode('leases')}
          className={`filter-tab ${viewMode === 'leases' ? 'active' : ''}`}
          data-state="all"
          data-has-items={leases.length > 0 ? 'true' : 'false'}
        >
          All Leases
          <span className="filter-tab-count">{leasesResponse?.pagination?.total || 0}</span>
        </button>
        <button
          onClick={() => setViewMode('credits')}
          className={`filter-tab ${viewMode === 'credits' ? 'active' : ''}`}
          data-state="active"
          data-has-items={credits.length > 0 ? 'true' : 'false'}
        >
          Credit Accounts
          <span className="filter-tab-count">{creditsResponse?.pagination?.total || 0}</span>
        </button>
      </div>

      {/* Leases View */}
      {viewMode === 'leases' && (
        <div className="catalog-section">
          <div className="catalog-section-header">
            <div className="catalog-section-title">
              Network Leases
              <span className="catalog-section-count">({leasesResponse?.pagination?.total || 0})</span>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="lease-state-filter" className="text-sm text-muted">State:</label>
              <select
                id="lease-state-filter"
                value={leaseStateFilter === 'all' ? 'all' : leaseStateToString(leaseStateFilter)}
                onChange={(e) => {
                  const val = e.target.value;
                  setLeaseStateFilter(val === 'all' ? 'all' : leaseStateFromString(val));
                }}
                className="input select text-sm py-1.5 px-2"
              >
                <option value="all">All</option>
                <option value={leaseStateToString(LeaseState.LEASE_STATE_PENDING)}>Pending</option>
                <option value={leaseStateToString(LeaseState.LEASE_STATE_ACTIVE)}>Active</option>
                <option value={leaseStateToString(LeaseState.LEASE_STATE_CLOSED)}>Closed</option>
                <option value={leaseStateToString(LeaseState.LEASE_STATE_REJECTED)}>Rejected</option>
                <option value={leaseStateToString(LeaseState.LEASE_STATE_EXPIRED)}>Expired</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            {loading ? (
              <>
                <SkeletonCard />
                <SkeletonCard />
                <SkeletonCard />
              </>
            ) : leases.length === 0 ? (
              <div className="catalog-empty">
                <span className="catalog-empty-text">No leases found</span>
              </div>
            ) : (
              [...leases]
                .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                .map((lease) => (
                  <NetworkLeaseCard
                    key={lease.uuid}
                    lease={lease}
                    getProvider={getProvider}
                    getSKU={getSKU}
                  />
                ))
            )}
          </div>

          {/* Pagination */}
          {totalLeasePages > 1 && (
            <Pagination
              currentPage={currentLeasePage}
              totalPages={totalLeasePages}
              totalItems={parseInt(leasesResponse?.pagination?.total || '0', 10)}
              itemsPerPage={PAGE_SIZE}
              onPageChange={(page) => setLeaseOffset((page - 1) * PAGE_SIZE)}
            />
          )}
        </div>
      )}

      {/* Credits View */}
      {viewMode === 'credits' && (
        <div className="catalog-section">
          <div className="catalog-section-header">
            <div className="catalog-section-title">
              Credit Accounts
              <span className="catalog-section-count">({creditsResponse?.pagination?.total || 0})</span>
            </div>
          </div>

          <div className="space-y-2">
            {loading ? (
              <>
                <SkeletonCard />
                <SkeletonCard />
                <SkeletonCard />
              </>
            ) : credits.length === 0 ? (
              <div className="catalog-empty">
                <span className="catalog-empty-text">No credit accounts found</span>
              </div>
            ) : (
              credits.map((account) => (
                <NetworkCreditCard
                  key={account.tenant}
                  account={account}
                  balances={creditsResponse?.balances?.[account.credit_address] || []}
                />
              ))
            )}
          </div>

          {/* Pagination */}
          {totalCreditPages > 1 && (
            <Pagination
              currentPage={currentCreditPage}
              totalPages={totalCreditPages}
              totalItems={parseInt(creditsResponse?.pagination?.total || '0', 10)}
              itemsPerPage={PAGE_SIZE}
              onPageChange={(page) => setCreditOffset((page - 1) * PAGE_SIZE)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================
   NETWORK LEASE CARD
   ============================================ */
interface NetworkLeaseCardProps {
  lease: Lease;
  getProvider: (uuid: string) => Provider | undefined;
  getSKU: (uuid: string) => SKU | undefined;
}

function NetworkLeaseCard({ lease, getProvider, getSKU }: NetworkLeaseCardProps) {
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

/* ============================================
   NETWORK CREDIT CARD
   ============================================ */
interface NetworkCreditCardProps {
  account: CreditAccount;
  balances: Coin[];
}

function NetworkCreditCard({ account, balances }: NetworkCreditCardProps) {
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
              <code className="lease-card-mono">{truncateAddress(account.credit_address)}</code>
              <button
                onClick={(e) => { e.stopPropagation(); copyToClipboard(account.credit_address); }}
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
              {account.active_lease_count} active
            </span>
            <span className="lease-card-time">
              <Clock size={11} />
              {account.pending_lease_count} pending
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
                <code className="lease-card-kv-value">{account.credit_address}</code>
                <button onClick={() => copyToClipboard(account.credit_address)} className="lease-card-copy-btn" title="Copy">
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
                <span className="lease-card-kv-value">{account.active_lease_count}</span>
              </div>
              <div className="lease-card-kv">
                <span className="lease-card-kv-label">Pending Leases</span>
                <span className="lease-card-kv-value">{account.pending_lease_count}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
