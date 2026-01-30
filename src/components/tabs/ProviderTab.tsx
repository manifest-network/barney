import { useState, useCallback, useRef } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Link, Building2, Shield } from 'lucide-react';
import { LeaseState, getLeasesByProvider, getWithdrawableAmount, getProviderWithdrawable, getBillingParams, type Lease, type ProviderWithdrawableResponse } from '../../api/billing';
import { SECONDS_PER_HOUR } from '../../config/constants';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { truncateAddress } from '../../utils/address';
import { getProviders, getSKUsByProvider, type Provider, type SKU } from '../../api/sku';
import { acknowledgeLease, rejectLease, withdrawFromLeases, closeLease, type TxResult } from '../../api/tx';
import { DENOM_METADATA, formatPrice } from '../../api/config';
import { formatDate } from '../../utils/format';
import type { Coin } from '../../api/bank';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';
import { AutoRefreshIndicator } from '../ui/AutoRefreshIndicator';
import { useToast } from '../../hooks/useToast';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonStatGrid } from '../ui/SkeletonStat';
import { SkeletonCard } from '../ui/SkeletonCard';
import { ErrorBanner } from '../ui/ErrorBanner';
import { useBatchSelection } from '../../hooks/useBatchSelection';

const CHAIN_NAME = 'manifestlocal';


export function ProviderTab() {
  const { address, isWalletConnected, openView, getOfflineSigner } = useChain(CHAIN_NAME);
  const toast = useToast();
  const { copyToClipboard } = useCopyToClipboard();

  const [myProvider, setMyProvider] = useState<Provider | null>(null);
  const [providerLeases, setProviderLeases] = useState<Lease[]>([]);
  const [providerSKUs, setProviderSKUs] = useState<SKU[]>([]);
  const [withdrawableAmounts, setWithdrawableAmounts] = useState<Map<string, Coin[]>>(new Map());
  const [providerWithdrawable, setProviderWithdrawable] = useState<ProviderWithdrawableResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInBillingAllowedList, setIsInBillingAllowedList] = useState(false);
  const [txLoading, setTxLoading] = useState(false);
  const { selected: selectedPendingLeases, toggle: togglePendingSelection, selectAll: selectAllPendingIds, clear: deselectAllPending } = useBatchSelection();
  const { selected: selectedActiveLeases, toggle: toggleActiveSelection, selectAll: selectAllActiveIds, clear: deselectAllActive } = useBatchSelection();

  // Track if initial load has completed
  const initialLoadRef = useRef(false);

  const fetchData = useCallback(async () => {
    if (!address) {
      setMyProvider(null);
      setProviderLeases([]);
      setProviderSKUs([]);
      setLoading(false);
      return;
    }

    try {
      // Only show loading on initial load
      if (!initialLoadRef.current) {
        setLoading(true);
      }
      setError(null);

      // Get all providers and find ours
      const [providers, billingParams] = await Promise.all([
        getProviders(),
        getBillingParams(),
      ]);

      const myProv = providers.find((p) => p.address === address);
      setMyProvider(myProv || null);
      setIsInBillingAllowedList(billingParams.allowed_list.includes(address));

      if (myProv) {
        // Fetch leases, SKUs, and provider-wide withdrawable summary
        const [leases, skus, withdrawableSummary] = await Promise.all([
          getLeasesByProvider(myProv.uuid),
          getSKUsByProvider(myProv.uuid),
          getProviderWithdrawable(myProv.uuid),
        ]);

        setProviderLeases(leases);
        setProviderSKUs(skus);
        setProviderWithdrawable(withdrawableSummary);

        // Fetch withdrawable amounts for active leases (for individual card display)
        const activeLeases = leases.filter((l) => l.state === LeaseState.LEASE_STATE_ACTIVE);
        const withdrawableMap = new Map<string, Coin[]>();

        await Promise.all(
          activeLeases.map(async (lease) => {
            try {
              const amounts = await getWithdrawableAmount(lease.uuid);
              withdrawableMap.set(lease.uuid, amounts);
            } catch {
              // Ignore errors for individual lease queries
            }
          })
        );

        setWithdrawableAmounts(withdrawableMap);
      }

      initialLoadRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [address]);

  const autoRefresh = useAutoRefresh(fetchData, {
    interval: 5000, // 5 seconds
    enabled: true,
    immediate: true,
  });

  const pendingLeases = providerLeases.filter((l) => l.state === LeaseState.LEASE_STATE_PENDING);
  const activeLeases = providerLeases.filter((l) => l.state === LeaseState.LEASE_STATE_ACTIVE);

  const handleAcknowledge = async (leaseUuid: string) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxLoading(true);

      const result: TxResult = await acknowledgeLease(signer, address, [leaseUuid]);

      if (result.success) {
        toast.success(`Lease acknowledged! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        await fetchData();
      } else {
        toast.error(`Failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(`Failed to acknowledge lease: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTxLoading(false);
    }
  };

  const handleReject = async (leaseUuid: string, reason: string) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxLoading(true);

      const result: TxResult = await rejectLease(signer, address, [leaseUuid], reason);

      if (result.success) {
        toast.success(`Lease rejected! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        await fetchData();
      } else {
        toast.error(`Failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(`Failed to reject lease: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTxLoading(false);
    }
  };

  const handleWithdraw = async (leaseUuids: string[]) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxLoading(true);

      const result: TxResult = await withdrawFromLeases(signer, address, leaseUuids);

      if (result.success) {
        toast.success(`Withdrawal successful! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        await fetchData();
      } else {
        toast.error(`Failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(`Failed to withdraw earnings: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTxLoading(false);
    }
  };

  const handleCloseLease = async (leaseUuid: string, reason?: string) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxLoading(true);

      const result: TxResult = await closeLease(signer, address, [leaseUuid], reason);

      if (result.success) {
        toast.success(`Lease closed! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        await fetchData();
      } else {
        toast.error(`Failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(`Failed to close lease: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTxLoading(false);
    }
  };

  const getSKU = (uuid: string) => providerSKUs.find((s) => s.uuid === uuid);

  // Batch operations
  const handleBatchAcknowledge = async () => {
    if (!address || selectedPendingLeases.size === 0) return;

    try {
      const signer = getOfflineSigner();
      const leaseUuids = Array.from(selectedPendingLeases);
      setTxLoading(true);

      const result: TxResult = await acknowledgeLease(signer, address, leaseUuids);

      if (result.success) {
        toast.success(`${leaseUuids.length} lease(s) acknowledged! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        deselectAllPending();
        await fetchData();
      } else {
        toast.error(`Failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(`Failed to acknowledge leases: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTxLoading(false);
    }
  };

  const handleBatchReject = async (reason: string) => {
    if (!address || selectedPendingLeases.size === 0) return;

    try {
      const signer = getOfflineSigner();
      const leaseUuids = Array.from(selectedPendingLeases);
      setTxLoading(true);

      const result: TxResult = await rejectLease(signer, address, leaseUuids, reason);

      if (result.success) {
        toast.success(`${leaseUuids.length} lease(s) rejected! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        deselectAllPending();
        await fetchData();
      } else {
        toast.error(`Failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(`Failed to reject leases: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTxLoading(false);
    }
  };

  const handleBatchClose = async (reason?: string) => {
    if (!address || selectedActiveLeases.size === 0) return;

    try {
      const signer = getOfflineSigner();
      const leaseUuids = Array.from(selectedActiveLeases);
      setTxLoading(true);

      const result: TxResult = await closeLease(signer, address, leaseUuids, reason);

      if (result.success) {
        toast.success(`${leaseUuids.length} lease(s) closed! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        deselectAllActive();
        await fetchData();
      } else {
        toast.error(`Failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(`Failed to close leases: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTxLoading(false);
    }
  };

  const handleBatchWithdraw = async () => {
    if (!address || selectedActiveLeases.size === 0) return;

    try {
      const signer = getOfflineSigner();
      const leaseUuids = Array.from(selectedActiveLeases);
      setTxLoading(true);

      const result: TxResult = await withdrawFromLeases(signer, address, leaseUuids);

      if (result.success) {
        toast.success(`Withdrawal from ${leaseUuids.length} lease(s) successful! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        deselectAllActive();
        await fetchData();
      } else {
        toast.error(`Failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(`Failed to withdraw from leases: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTxLoading(false);
    }
  };

  const selectAllPending = () => selectAllPendingIds(pendingLeases.map((l) => l.uuid));
  const selectAllActive = () => selectAllActiveIds(activeLeases.map((l) => l.uuid));

  if (!isWalletConnected) {
    return (
      <EmptyState
        icon={Link}
        title="Connect Your Wallet"
        description="Connect your wallet to view your provider dashboard"
        action={{ label: 'Connect Wallet', onClick: () => openView() }}
      />
    );
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <SkeletonCard />
        <SkeletonStatGrid count={3} />
        <SkeletonCard />
      </div>
    );
  }

  if (error) {
    return <ErrorBanner error={error} onRetry={autoRefresh.refresh} />;
  }

  if (!myProvider) {
    return (
      <div className="card-static p-8 text-center">
        <div className="empty-state-icon-wrapper">
          <Building2 size={48} className="empty-state-icon" />
        </div>
        <h2 className="empty-state-title">No Provider Found</h2>
        <p className="empty-state-description">
          Your connected address is not associated with any provider.
        </p>
        <p className="mt-4 text-sm text-dim">
          Connected as: <span className="font-mono">{truncateAddress(address || '')}</span>
        </p>
      </div>
    );
  }

  const totalWithdrawable = providerWithdrawable?.amounts || [];

  return (
    <div className="space-y-4">
      {/* Billing Module Status */}
      {isInBillingAllowedList && (
        <div className="card-static p-3 border-primary-500/50 bg-primary-500/10">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-primary-400" />
            <span className="font-medium text-primary-300">Billing Module Admin</span>
          </div>
          <p className="mt-1 text-sm text-primary-400/80">
            Your wallet is in the billing module allowed list.
          </p>
        </div>
      )}

      {/* Provider Info Card */}
      <div className="card-static p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="mb-2 text-lg font-heading font-semibold">Your Provider</h2>
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted">UUID:</span>
                <span className="font-mono text-secondary">{myProvider.uuid}</span>
                <button
                  onClick={() => copyToClipboard(myProvider.uuid)}
                  className="text-xs text-primary-400 hover:text-primary-300"
                >
                  Copy
                </button>
              </div>
              <div>
                <span className="text-muted">Address: </span>
                <span className="font-mono text-secondary">{truncateAddress(myProvider.address)}</span>
              </div>
              <div>
                <span className="text-muted">Payout: </span>
                <span className="font-mono text-secondary">{truncateAddress(myProvider.payout_address)}</span>
              </div>
              <div>
                <span className="text-muted">API: </span>
                <span className="text-primary-400">{myProvider.api_url}</span>
              </div>
              <div>
                <span className="text-muted">Status: </span>
                <span className={myProvider.active ? 'text-success' : 'text-error'}>
                  {myProvider.active ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm text-muted">Total Withdrawable</div>
            {totalWithdrawable.length === 0 ? (
              <div className="text-2xl font-bold text-dim">0</div>
            ) : (
              totalWithdrawable.map((coin) => (
                <div key={coin.denom} className="text-2xl font-bold text-success">
                  {formatPrice(coin.amount, coin.denom)}
                </div>
              ))
            )}
            {activeLeases.length > 0 && totalWithdrawable.length > 0 && (
              <button
                onClick={() => handleWithdraw(activeLeases.map((l) => l.uuid))}
                disabled={txLoading}
                className="btn btn-success mt-2"
              >
                Withdraw All
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="stat-card">
          <div className="stat-value text-warning">{pendingLeases.length}</div>
          <div className="stat-label">Pending Approval</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-success">{activeLeases.length}</div>
          <div className="stat-label">Active Leases</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-primary">
            {providerSKUs.filter((s) => s.active).length}
          </div>
          <div className="stat-label">Active SKUs</div>
        </div>
      </div>

      {/* Pending Leases */}
      <div className="card-static p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-lg font-heading font-semibold">
            Pending Leases
            {pendingLeases.length > 0 && (
              <span className="ml-2 badge badge-warning">
                {pendingLeases.length}
              </span>
            )}
          </h2>
          <AutoRefreshIndicator autoRefresh={autoRefresh} intervalSeconds={5} />
        </div>

        {/* Batch Selection Controls */}
        {pendingLeases.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-4 rounded-lg border border-surface-700 bg-surface-800/50 p-3">
            <div className="flex items-center gap-2">
              <button
                onClick={selectAllPending}
                className="text-sm text-primary-400 hover:text-primary-300"
              >
                Select All
              </button>
              <span className="text-surface-600">|</span>
              <button
                onClick={deselectAllPending}
                className="text-sm text-muted hover:text-primary"
              >
                Deselect All
              </button>
              {selectedPendingLeases.size > 0 && (
                <span className="ml-2 text-sm text-muted">
                  ({selectedPendingLeases.size} selected)
                </span>
              )}
            </div>
            {selectedPendingLeases.size > 0 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleBatchAcknowledge}
                  disabled={txLoading}
                  className="btn btn-success btn-sm"
                >
                  Acknowledge {selectedPendingLeases.size}
                </button>
                <button
                  onClick={() => handleBatchReject('')}
                  disabled={txLoading}
                  className="btn btn-danger btn-sm"
                >
                  Reject {selectedPendingLeases.size}
                </button>
              </div>
            )}
          </div>
        )}

        {pendingLeases.length === 0 ? (
          <p className="text-muted">No pending leases to review</p>
        ) : (
          <div className="space-y-2">
            {pendingLeases.map((lease) => (
              <PendingLeaseCard
                key={lease.uuid}
                lease={lease}
                getSKU={getSKU}
                onAcknowledge={handleAcknowledge}
                onReject={handleReject}
                txLoading={txLoading || false}
                isSelected={selectedPendingLeases.has(lease.uuid)}
                onToggleSelect={() => togglePendingSelection(lease.uuid)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Active Leases */}
      <div className="card-static p-4">
        <h2 className="mb-4 text-lg font-heading font-semibold">Active Leases</h2>

        {/* Batch Selection Controls */}
        {activeLeases.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-4 rounded-lg border border-surface-700 bg-surface-800/50 p-3">
            <div className="flex items-center gap-2">
              <button
                onClick={selectAllActive}
                className="text-sm text-primary-400 hover:text-primary-300"
              >
                Select All
              </button>
              <span className="text-surface-600">|</span>
              <button
                onClick={deselectAllActive}
                className="text-sm text-muted hover:text-primary"
              >
                Deselect All
              </button>
              {selectedActiveLeases.size > 0 && (
                <span className="ml-2 text-sm text-muted">
                  ({selectedActiveLeases.size} selected)
                </span>
              )}
            </div>
            {selectedActiveLeases.size > 0 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleBatchWithdraw}
                  disabled={txLoading}
                  className="btn btn-success btn-sm"
                >
                  Withdraw {selectedActiveLeases.size}
                </button>
                <button
                  onClick={() => handleBatchClose()}
                  disabled={txLoading}
                  className="btn btn-secondary btn-sm"
                >
                  Close {selectedActiveLeases.size}
                </button>
              </div>
            )}
          </div>
        )}

        {activeLeases.length === 0 ? (
          <p className="text-muted">No active leases</p>
        ) : (
          <div className="space-y-2">
            {activeLeases.map((lease) => (
              <ActiveLeaseCard
                key={lease.uuid}
                lease={lease}
                getSKU={getSKU}
                withdrawable={withdrawableAmounts.get(lease.uuid) || []}
                onWithdraw={() => handleWithdraw([lease.uuid])}
                onClose={(reason) => handleCloseLease(lease.uuid, reason)}
                txLoading={txLoading || false}
                isSelected={selectedActiveLeases.has(lease.uuid)}
                onToggleSelect={() => toggleActiveSelection(lease.uuid)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PendingLeaseCard({
  lease,
  getSKU,
  onAcknowledge,
  onReject,
  txLoading,
  isSelected,
  onToggleSelect,
}: {
  lease: Lease;
  getSKU: (uuid: string) => SKU | undefined;
  onAcknowledge: (uuid: string) => void;
  onReject: (uuid: string, reason: string) => void;
  txLoading: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}) {
  const { copyToClipboard } = useCopyToClipboard();
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);

  return (
    <div className={`rounded-lg border bg-warning-500/10 p-4 ${isSelected ? 'border-primary-500' : 'border-warning-500/30'}`}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={isSelected || false}
              onChange={onToggleSelect}
              className="mt-1 h-4 w-4 rounded border-surface-600 bg-surface-700 text-primary-600 focus:ring-primary-500 focus:ring-offset-surface-800"
            />
          )}
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-secondary">{lease.uuid}</span>
              <button
                onClick={() => copyToClipboard(lease.uuid)}
                className="text-xs text-primary-400 hover:text-primary-300"
              >
                Copy
              </button>
            </div>
            <div className="mt-1 text-sm text-muted">
              Tenant: <span className="font-mono">{truncateAddress(lease.tenant)}</span>
            </div>
            <div className="text-xs text-dim">
              Created: {formatDate(lease.created_at)}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onAcknowledge(lease.uuid)}
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
        </div>
      </div>

      {/* Items */}
      <div className="mb-3 rounded-lg bg-surface-800/50 p-2">
        <div className="text-xs font-medium uppercase text-dim">Requested Items</div>
        {lease.items.map((item) => {
          const sku = getSKU(item.sku_uuid);
          return (
            <div key={`${lease.uuid}-item-${item.sku_uuid}`} className="mt-1 flex justify-between text-sm">
              <span className="text-primary">
                {sku?.name || item.sku_uuid} × {item.quantity}
              </span>
              <span className="text-muted">
                {formatPrice(item.locked_price.amount, item.locked_price.denom)}/sec
              </span>
            </div>
          );
        })}
      </div>

      {/* Reject Form */}
      {showRejectForm && (
        <div className="mt-3 border-t border-surface-700 pt-3">
          <label className="mb-1 block text-sm text-muted">Rejection Reason (optional)</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g., Insufficient capacity"
              maxLength={256}
              className="input flex-1 text-sm"
              disabled={txLoading}
            />
            <button
              onClick={() => {
                onReject(lease.uuid, rejectReason);
                setShowRejectForm(false);
                setRejectReason('');
              }}
              disabled={txLoading}
              className="btn btn-danger btn-sm"
            >
              Confirm Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ActiveLeaseCard({
  lease,
  getSKU,
  withdrawable,
  onWithdraw,
  onClose,
  txLoading,
  isSelected,
  onToggleSelect,
}: {
  lease: Lease;
  getSKU: (uuid: string) => SKU | undefined;
  withdrawable: Coin[];
  onWithdraw: () => void;
  onClose: (reason?: string) => void;
  txLoading: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}) {
  const { copyToClipboard } = useCopyToClipboard();
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [closeReason, setCloseReason] = useState('');

  const hourlyRate = () => {
    let total = 0;
    let denom = '';
    for (const item of lease.items) {
      const perSecond = parseInt(item.locked_price.amount, 10);
      total += perSecond * parseInt(item.quantity, 10) * SECONDS_PER_HOUR;
      denom = item.locked_price.denom;
    }
    const meta = DENOM_METADATA[denom];
    const symbol = meta?.symbol || denom;
    const exponent = meta?.exponent || 6;
    return `${(total / Math.pow(10, exponent)).toFixed(4)} ${symbol}/hr`;
  };

  return (
    <div className={`rounded-lg border bg-success-500/10 p-4 ${isSelected ? 'border-primary-500' : 'border-success-500/30'}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={isSelected || false}
              onChange={onToggleSelect}
              className="mt-1 h-4 w-4 rounded border-surface-600 bg-surface-700 text-primary-600 focus:ring-primary-500 focus:ring-offset-surface-800"
            />
          )}
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-secondary">{lease.uuid}</span>
              <button
                onClick={() => copyToClipboard(lease.uuid)}
                className="text-xs text-primary-400 hover:text-primary-300"
              >
                Copy
              </button>
            </div>
            <div className="mt-1 text-sm text-muted">
              Tenant: <span className="font-mono">{truncateAddress(lease.tenant)}</span>
            </div>
            <div className="text-xs text-dim">
              Active since: {formatDate(lease.acknowledged_at)}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm text-muted">Withdrawable</div>
          {withdrawable.length === 0 ? (
            <div className="font-bold text-dim">0</div>
          ) : (
            withdrawable.map((coin) => (
              <div key={coin.denom} className="font-bold text-success">
                {formatPrice(coin.amount, coin.denom)}
              </div>
            ))
          )}
          <div className="text-xs text-dim">@ {hourlyRate()}</div>
        </div>
      </div>

      {/* Items */}
      <div className="mt-3 rounded-lg bg-surface-800/50 p-2">
        {lease.items.map((item) => {
          const sku = getSKU(item.sku_uuid);
          return (
            <div key={`${lease.uuid}-item-${item.sku_uuid}`} className="flex justify-between text-sm">
              <span className="text-primary">
                {sku?.name || item.sku_uuid} × {item.quantity}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          onClick={onWithdraw}
          disabled={txLoading || withdrawable.length === 0}
          className="btn btn-success btn-sm"
        >
          Withdraw
        </button>
        <button
          onClick={() => setShowCloseForm(!showCloseForm)}
          disabled={txLoading}
          className="btn btn-secondary btn-sm"
        >
          Close Lease
        </button>
      </div>

      {/* Close Form */}
      {showCloseForm && (
        <div className="mt-3 border-t border-surface-700 pt-3">
          <label className="mb-1 block text-sm text-muted">Closure Reason (optional)</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              placeholder="e.g., Resource decommissioned"
              maxLength={256}
              className="input flex-1 text-sm"
              disabled={txLoading}
            />
            <button
              onClick={() => {
                onClose(closeReason || undefined);
                setShowCloseForm(false);
                setCloseReason('');
              }}
              disabled={txLoading}
              className="btn btn-secondary btn-sm"
            >
              Confirm Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
