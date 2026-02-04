import { useState, useEffect, useCallback } from 'react';
import { Link, ShieldX, Globe, Check, Clock, Zap, Package, Users } from 'lucide-react';
import {
  LeaseState,
  leaseStateToString,
  leaseStateFromString,
  getAllLeases,
  getAllCredits,
  type PaginatedLeasesResponse,
  type PaginatedCreditsResponse,
} from '../../../api/billing';
import { logError } from '../../../utils/errors';
import { getProviders, getSKUs, type Provider, type SKU } from '../../../api/sku';
import { useAutoRefreshContext } from '../../../contexts/AutoRefreshContext';
import { useAutoRefreshTab } from '../../../hooks/useAutoRefreshTab';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorBanner } from '../../ui/ErrorBanner';
import { SkeletonCard } from '../../ui/SkeletonCard';
import { Pagination } from '../../ui/Pagination';
import { NetworkLeaseCard } from './NetworkLeaseCard';
import { NetworkCreditCard } from './NetworkCreditCard';
import { DEFAULT_PAGE_SIZE } from '../../../config/constants';
import type { ViewMode } from './types';

export function NetworkTab({ isConnected, onConnect, isAdmin }: { isConnected: boolean; onConnect: () => void; isAdmin: boolean }) {
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

  // Loading and error state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Network stats
  const [stats, setStats] = useState<{
    totalLeases: number;
    pendingLeases: number;
    activeLeases: number;
    closedLeases: number;
    totalProviders: number;
    totalSKUs: number;
  } | null>(null);

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
        totalLeases: Number(pending.pagination?.total ?? 0n) +
                     Number(active.pagination?.total ?? 0n) +
                     Number(closed.pagination?.total ?? 0n),
        pendingLeases: Number(pending.pagination?.total ?? 0n),
        activeLeases: Number(active.pagination?.total ?? 0n),
        closedLeases: Number(closed.pagination?.total ?? 0n),
        totalProviders: providersData.length,
        totalSKUs: skusData.length,
      });
    } catch (err) {
      logError('NetworkTab.fetchReferenceData', err);
    }
  }, []);

  // Separate fetch functions with showLoading control
  const fetchLeases = useCallback(async (showLoading: boolean) => {
    try {
      if (showLoading) setLoading(true);
      setError(null);
      const response = await getAllLeases({
        stateFilter: leaseStateFilter === 'all' ? undefined : leaseStateFilter,
        limit: DEFAULT_PAGE_SIZE,
        offset: leaseOffset,
      });
      setLeasesResponse(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch leases');
    } finally {
      setLoading(false);
    }
  }, [leaseStateFilter, leaseOffset]);

  const fetchCredits = useCallback(async (showLoading: boolean) => {
    try {
      if (showLoading) setLoading(true);
      setError(null);
      const response = await getAllCredits({
        limit: DEFAULT_PAGE_SIZE,
        offset: creditOffset,
      });
      setCreditsResponse(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch credits');
    } finally {
      setLoading(false);
    }
  }, [creditOffset]);

  // Combined fetch for auto-refresh (no loading spinner)
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

  // Initial load with loading spinner
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
    Number(leasesResponse?.pagination?.total ?? 0n) / DEFAULT_PAGE_SIZE
  );
  const currentLeasePage = Math.floor(leaseOffset / DEFAULT_PAGE_SIZE) + 1;

  const totalCreditPages = Math.ceil(
    Number(creditsResponse?.pagination?.total ?? 0n) / DEFAULT_PAGE_SIZE
  );
  const currentCreditPage = Math.floor(creditOffset / DEFAULT_PAGE_SIZE) + 1;

  const leases = leasesResponse?.leases || [];
  const credits = creditsResponse?.creditAccounts || [];

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
          <span className="filter-tab-count">{String(leasesResponse?.pagination?.total ?? 0n)}</span>
        </button>
        <button
          onClick={() => setViewMode('credits')}
          className={`filter-tab ${viewMode === 'credits' ? 'active' : ''}`}
          data-state="active"
          data-has-items={credits.length > 0 ? 'true' : 'false'}
        >
          Credit Accounts
          <span className="filter-tab-count">{String(creditsResponse?.pagination?.total ?? 0n)}</span>
        </button>
      </div>

      {/* Leases View */}
      {viewMode === 'leases' && (
        <div className="catalog-section">
          <div className="catalog-section-header">
            <div className="catalog-section-title">
              Network Leases
              <span className="catalog-section-count">({String(leasesResponse?.pagination?.total ?? 0n)})</span>
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
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
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
              totalItems={Number(leasesResponse?.pagination?.total ?? 0n)}
              itemsPerPage={DEFAULT_PAGE_SIZE}
              onPageChange={(page) => setLeaseOffset((page - 1) * DEFAULT_PAGE_SIZE)}
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
              <span className="catalog-section-count">({String(creditsResponse?.pagination?.total ?? 0n)})</span>
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
                  balances={creditsResponse?.balances?.[account.creditAddress] || []}
                />
              ))
            )}
          </div>

          {/* Pagination */}
          {totalCreditPages > 1 && (
            <Pagination
              currentPage={currentCreditPage}
              totalPages={totalCreditPages}
              totalItems={Number(creditsResponse?.pagination?.total ?? 0n)}
              itemsPerPage={DEFAULT_PAGE_SIZE}
              onPageChange={(page) => setCreditOffset((page - 1) * DEFAULT_PAGE_SIZE)}
            />
          )}
        </div>
      )}
    </div>
  );
}
