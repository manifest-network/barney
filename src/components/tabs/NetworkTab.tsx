import { useState, useEffect, useCallback } from 'react';
import { Link, ShieldX, Globe } from 'lucide-react';
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
import { truncateAddress } from '../../utils/address';
import { formatAmount, formatDate } from '../../utils/format';
import { LEASE_STATE_BADGE_CLASSES, LEASE_STATE_LABELS, LEASE_STATE_COLORS } from '../../utils/leaseState';
import { getProviders, getSKUs, type Provider, type SKU } from '../../api/sku';
import type { Coin } from '../../api/bank';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';
import { AutoRefreshIndicator } from '../AutoRefreshIndicator';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonTable } from '../ui/SkeletonCard';
import { StatCard } from '../ui/StatCard';

const PAGE_SIZE = 20;

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

  const autoRefresh = useAutoRefresh(fetchCurrentView, {
    interval: 30000, // 30 seconds for network stats (less critical)
    enabled: isAdmin,
    immediate: false, // We'll handle initial load separately
  });

  // Initial data load
  useEffect(() => {
    if (isAdmin) {
      fetchReferenceData();
    }
  }, [isAdmin, fetchReferenceData]);

  // Fetch data when view mode or filters change
  useEffect(() => {
    if (isAdmin) {
      if (viewMode === 'leases') {
        fetchLeases(true);
      } else {
        fetchCredits(true);
      }
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
      <div className="card-static p-12 text-center">
        <div className="empty-state-icon-wrapper">
          <ShieldX size={48} className="empty-state-icon" />
        </div>
        <h2 className="empty-state-title">Access Denied</h2>
        <p className="empty-state-description">
          Your wallet is not in the billing module allowed list.
        </p>
        <p className="mt-4 text-sm text-dim">
          Connected as: <span className="font-mono">{truncateAddress(address || '')}</span>
        </p>
      </div>
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

  return (
    <div className="space-y-6">
      {/* Admin Badge */}
      <div className="card-static p-4 border-purple-700 bg-purple-900/20">
        <div className="flex items-center gap-2">
          <Globe size={16} className="text-purple-400" />
          <span className="font-medium text-purple-300">Network Admin Dashboard</span>
        </div>
        <p className="mt-1 text-sm text-purple-400/80">
          Viewing network-wide billing data
        </p>
      </div>

      {/* Network Stats */}
      {stats && (
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard value={stats.totalLeases} label="Total Leases" />
          <StatCard value={stats.pendingLeases} label="Pending" colorClass={LEASE_STATE_COLORS[LeaseState.LEASE_STATE_PENDING]} />
          <StatCard value={stats.activeLeases} label="Active" colorClass={LEASE_STATE_COLORS[LeaseState.LEASE_STATE_ACTIVE]} />
          <StatCard value={stats.closedLeases} label="Closed" colorClass={LEASE_STATE_COLORS[LeaseState.LEASE_STATE_CLOSED]} />
          <StatCard value={stats.totalProviders} label="Providers" colorClass="text-blue-400" />
          <StatCard value={stats.totalSKUs} label="SKUs" colorClass="text-purple-400" />
        </div>
      )}

      {/* View Mode Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-gray-700">
        <nav className="nav-tabs">
          <button
            onClick={() => setViewMode('leases')}
            className={`nav-tab ${viewMode === 'leases' ? 'active' : ''}`}
          >
            All Leases
          </button>
          <button
            onClick={() => setViewMode('credits')}
            className={`nav-tab ${viewMode === 'credits' ? 'active' : ''}`}
          >
            All Credit Accounts
          </button>
        </nav>
        <AutoRefreshIndicator autoRefresh={autoRefresh} intervalSeconds={30} />
      </div>

      {/* Error */}
      {error && (
        <div className="card-static p-4 border-error-500/50 bg-error-500/10">
          <span className="text-error">{error}</span>
          <button
            onClick={autoRefresh.refresh}
            className="ml-4 text-blue-400 hover:text-blue-300"
          >
            Retry
          </button>
        </div>
      )}

      {/* Leases View */}
      {viewMode === 'leases' && (
        <div className="card-static p-6">
          {/* Filters */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <label htmlFor="lease-state-filter" className="text-sm text-muted">Filter:</label>
              <select
                id="lease-state-filter"
                value={leaseStateFilter === 'all' ? 'all' : leaseStateToString(leaseStateFilter)}
                onChange={(e) => {
                  const val = e.target.value;
                  setLeaseStateFilter(val === 'all' ? 'all' : leaseStateFromString(val));
                }}
                className="input select"
                aria-label="Filter leases by state"
              >
                <option value="all">All States</option>
                <option value={leaseStateToString(LeaseState.LEASE_STATE_PENDING)}>Pending</option>
                <option value={leaseStateToString(LeaseState.LEASE_STATE_ACTIVE)}>Active</option>
                <option value={leaseStateToString(LeaseState.LEASE_STATE_CLOSED)}>Closed</option>
                <option value={leaseStateToString(LeaseState.LEASE_STATE_REJECTED)}>Rejected</option>
                <option value={leaseStateToString(LeaseState.LEASE_STATE_EXPIRED)}>Expired</option>
              </select>
            </div>
            <div className="text-sm text-muted">
              {leasesResponse?.pagination?.total || 0} total leases
            </div>
          </div>

          {/* Leases Table */}
          {loading ? (
            <SkeletonTable />
          ) : leasesResponse?.leases?.length === 0 ? (
            <div className="py-8 text-center text-muted">No leases found</div>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Lease UUID</th>
                    <th>Tenant</th>
                    <th>Provider</th>
                    <th>State</th>
                    <th>Items</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {leasesResponse?.leases?.map((lease) => (
                    <LeaseRow
                      key={lease.uuid}
                      lease={lease}
                      getProvider={getProvider}
                      getSKU={getSKU}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {totalLeasePages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <button
                onClick={() => setLeaseOffset(Math.max(0, leaseOffset - PAGE_SIZE))}
                disabled={leaseOffset === 0}
                className="btn btn-secondary btn-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm text-muted">
                Page {currentLeasePage} of {totalLeasePages}
              </span>
              <button
                onClick={() => setLeaseOffset(leaseOffset + PAGE_SIZE)}
                disabled={currentLeasePage >= totalLeasePages}
                className="btn btn-secondary btn-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* Credits View */}
      {viewMode === 'credits' && (
        <div className="card-static p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-heading font-semibold">Credit Accounts</h3>
            <div className="text-sm text-muted">
              {creditsResponse?.pagination?.total || 0} total accounts
            </div>
          </div>

          {/* Credits Table */}
          {loading ? (
            <SkeletonTable />
          ) : creditsResponse?.credit_accounts?.length === 0 ? (
            <div className="py-8 text-center text-muted">No credit accounts found</div>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Tenant</th>
                    <th>Balance</th>
                    <th>Active Leases</th>
                    <th>Pending Leases</th>
                    <th>Credit Address</th>
                  </tr>
                </thead>
                <tbody>
                  {creditsResponse?.credit_accounts?.map((account) => (
                    <CreditRow
                      key={account.tenant}
                      account={account}
                      balances={creditsResponse.balances?.[account.tenant] || []}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {totalCreditPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <button
                onClick={() => setCreditOffset(Math.max(0, creditOffset - PAGE_SIZE))}
                disabled={creditOffset === 0}
                className="btn btn-secondary btn-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm text-muted">
                Page {currentCreditPage} of {totalCreditPages}
              </span>
              <button
                onClick={() => setCreditOffset(creditOffset + PAGE_SIZE)}
                disabled={currentCreditPage >= totalCreditPages}
                className="btn btn-secondary btn-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LeaseRow({
  lease,
  getProvider,
  getSKU,
}: {
  lease: Lease;
  getProvider: (uuid: string) => Provider | undefined;
  getSKU: (uuid: string) => SKU | undefined;
}) {
  const { copied, copyToClipboard } = useCopyToClipboard();
  const provider = getProvider(lease.provider_uuid);

  const handleCopy = () => {
    copyToClipboard(lease.uuid);
  };

  return (
    <tr>
      <td>
        <button
          onClick={handleCopy}
          className="font-mono text-xs text-gray-300 hover:text-white"
          title={lease.uuid}
        >
          {lease.uuid.slice(0, 8)}...
          <span className="ml-1 text-gray-600">{copied ? '(copied!)' : ''}</span>
        </button>
      </td>
      <td>
        <span className="font-mono text-sm text-gray-300" title={lease.tenant}>
          {truncateAddress(lease.tenant)}
        </span>
      </td>
      <td>
        <span className="text-sm text-gray-300" title={provider?.address}>
          {provider ? truncateAddress(provider.address) : lease.provider_uuid.slice(0, 8)}
        </span>
      </td>
      <td>
        <span className={LEASE_STATE_BADGE_CLASSES[lease.state]}>
          {LEASE_STATE_LABELS[lease.state]}
        </span>
      </td>
      <td>
        <div className="text-sm text-muted">
          {lease.items.map((item, idx) => {
            const sku = getSKU(item.sku_uuid);
            return (
              <span key={`${lease.uuid}-${item.sku_uuid}-${idx}`}>
                {sku?.name || item.sku_uuid.slice(0, 8)} x{item.quantity}
                {idx < lease.items.length - 1 ? ', ' : ''}
              </span>
            );
          })}
        </div>
      </td>
      <td className="text-sm text-dim">{formatDate(lease.created_at, 'date')}</td>
    </tr>
  );
}

function CreditRow({
  account,
  balances,
}: {
  account: CreditAccount;
  balances: Coin[];
}) {
  const { copied, copyToClipboard } = useCopyToClipboard();

  const handleCopy = () => {
    copyToClipboard(account.tenant);
  };

  return (
    <tr>
      <td>
        <button
          onClick={handleCopy}
          className="font-mono text-sm text-gray-300 hover:text-white"
          title={account.tenant}
        >
          {truncateAddress(account.tenant)}
          <span className="ml-1 text-gray-600">{copied ? '(copied!)' : ''}</span>
        </button>
      </td>
      <td>
        {balances.length === 0 ? (
          <span className="text-dim">0</span>
        ) : (
          <div className="text-sm">
            {balances.map((coin) => (
              <div key={coin.denom} className="text-green-400">
                {formatAmount(coin.amount, coin.denom)}
              </div>
            ))}
          </div>
        )}
      </td>
      <td>
        <span className={`text-sm ${account.active_lease_count > 0 ? 'text-green-400' : 'text-dim'}`}>
          {account.active_lease_count}
        </span>
      </td>
      <td>
        <span className={`text-sm ${account.pending_lease_count > 0 ? 'text-yellow-400' : 'text-dim'}`}>
          {account.pending_lease_count}
        </span>
      </td>
      <td>
        <span className="font-mono text-xs text-dim" title={account.credit_address}>
          {truncateAddress(account.credit_address)}
        </span>
      </td>
    </tr>
  );
}
