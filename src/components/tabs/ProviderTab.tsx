import { useState, useCallback } from 'react';
import { useChain } from '@cosmos-kit/react';
import type { Lease, ProviderWithdrawableResponse } from '../../api/billing';
import { getLeasesByProvider, getWithdrawableAmount, getProviderWithdrawable, getBillingParams } from '../../api/billing';
import { getProviders, getSKUsByProvider, type Provider, type SKU } from '../../api/sku';
import { acknowledgeLease, rejectLease, withdrawFromLeases, closeLease, type TxResult } from '../../api/tx';
import { DENOM_METADATA, formatPrice } from '../../api/config';
import type { Coin } from '../../api/bank';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';
import { AutoRefreshIndicator } from '../AutoRefreshIndicator';

const CHAIN_NAME = 'manifestlocal';

function formatAddress(addr: string): string {
  if (!addr || addr.length < 20) return addr;
  const prefix = addr.slice(0, 9);
  const start = addr.slice(9, 13);
  const end = addr.slice(-4);
  return `${prefix}${start}...${end}`;
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
}

export function ProviderTab() {
  const { address, isWalletConnected, openView, getOfflineSigner } = useChain(CHAIN_NAME);

  const [myProvider, setMyProvider] = useState<Provider | null>(null);
  const [providerLeases, setProviderLeases] = useState<Lease[]>([]);
  const [providerSKUs, setProviderSKUs] = useState<SKU[]>([]);
  const [withdrawableAmounts, setWithdrawableAmounts] = useState<Map<string, Coin[]>>(new Map());
  const [providerWithdrawable, setProviderWithdrawable] = useState<ProviderWithdrawableResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInBillingAllowedList, setIsInBillingAllowedList] = useState(false);
  const [txStatus, setTxStatus] = useState<{ loading: boolean; message: string } | null>(null);
  const [selectedPendingLeases, setSelectedPendingLeases] = useState<Set<string>>(new Set());
  const [selectedActiveLeases, setSelectedActiveLeases] = useState<Set<string>>(new Set());

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
      if (!myProvider) {
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
        const activeLeases = leases.filter((l) => l.state === 'LEASE_STATE_ACTIVE');
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [address, myProvider]);

  const autoRefresh = useAutoRefresh(fetchData, {
    interval: 5000, // 5 seconds
    enabled: true,
    immediate: true,
  });

  const pendingLeases = providerLeases.filter((l) => l.state === 'LEASE_STATE_PENDING');
  const activeLeases = providerLeases.filter((l) => l.state === 'LEASE_STATE_ACTIVE');

  const handleAcknowledge = async (leaseUuid: string) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxStatus({ loading: true, message: 'Acknowledging lease...' });

      const result: TxResult = await acknowledgeLease(signer, address, [leaseUuid]);

      if (result.success) {
        setTxStatus({ loading: false, message: `Lease acknowledged! Tx: ${result.transactionHash}` });
        await fetchData();
      } else {
        setTxStatus({ loading: false, message: `Failed: ${result.error}` });
      }
    } catch (err) {
      setTxStatus({ loading: false, message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` });
    }
  };

  const handleReject = async (leaseUuid: string, reason: string) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxStatus({ loading: true, message: 'Rejecting lease...' });

      const result: TxResult = await rejectLease(signer, address, [leaseUuid], reason);

      if (result.success) {
        setTxStatus({ loading: false, message: `Lease rejected! Tx: ${result.transactionHash}` });
        await fetchData();
      } else {
        setTxStatus({ loading: false, message: `Failed: ${result.error}` });
      }
    } catch (err) {
      setTxStatus({ loading: false, message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` });
    }
  };

  const handleWithdraw = async (leaseUuids: string[]) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxStatus({ loading: true, message: 'Withdrawing funds...' });

      const result: TxResult = await withdrawFromLeases(signer, address, leaseUuids);

      if (result.success) {
        setTxStatus({ loading: false, message: `Withdrawal successful! Tx: ${result.transactionHash}` });
        await fetchData();
      } else {
        setTxStatus({ loading: false, message: `Failed: ${result.error}` });
      }
    } catch (err) {
      setTxStatus({ loading: false, message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` });
    }
  };

  const handleCloseLease = async (leaseUuid: string, reason?: string) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxStatus({ loading: true, message: 'Closing lease...' });

      const result: TxResult = await closeLease(signer, address, [leaseUuid], reason);

      if (result.success) {
        setTxStatus({ loading: false, message: `Lease closed! Tx: ${result.transactionHash}` });
        await fetchData();
      } else {
        setTxStatus({ loading: false, message: `Failed: ${result.error}` });
      }
    } catch (err) {
      setTxStatus({ loading: false, message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` });
    }
  };

  const getSKU = (uuid: string) => providerSKUs.find((s) => s.uuid === uuid);

  // Batch operations
  const handleBatchAcknowledge = async () => {
    if (!address || selectedPendingLeases.size === 0) return;

    try {
      const signer = getOfflineSigner();
      const leaseUuids = Array.from(selectedPendingLeases);
      setTxStatus({ loading: true, message: `Acknowledging ${leaseUuids.length} lease(s)...` });

      const result: TxResult = await acknowledgeLease(signer, address, leaseUuids);

      if (result.success) {
        setTxStatus({ loading: false, message: `${leaseUuids.length} lease(s) acknowledged! Tx: ${result.transactionHash}` });
        setSelectedPendingLeases(new Set());
        await fetchData();
      } else {
        setTxStatus({ loading: false, message: `Failed: ${result.error}` });
      }
    } catch (err) {
      setTxStatus({ loading: false, message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` });
    }
  };

  const handleBatchReject = async (reason: string) => {
    if (!address || selectedPendingLeases.size === 0) return;

    try {
      const signer = getOfflineSigner();
      const leaseUuids = Array.from(selectedPendingLeases);
      setTxStatus({ loading: true, message: `Rejecting ${leaseUuids.length} lease(s)...` });

      const result: TxResult = await rejectLease(signer, address, leaseUuids, reason);

      if (result.success) {
        setTxStatus({ loading: false, message: `${leaseUuids.length} lease(s) rejected! Tx: ${result.transactionHash}` });
        setSelectedPendingLeases(new Set());
        await fetchData();
      } else {
        setTxStatus({ loading: false, message: `Failed: ${result.error}` });
      }
    } catch (err) {
      setTxStatus({ loading: false, message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` });
    }
  };

  const handleBatchClose = async (reason?: string) => {
    if (!address || selectedActiveLeases.size === 0) return;

    try {
      const signer = getOfflineSigner();
      const leaseUuids = Array.from(selectedActiveLeases);
      setTxStatus({ loading: true, message: `Closing ${leaseUuids.length} lease(s)...` });

      const result: TxResult = await closeLease(signer, address, leaseUuids, reason);

      if (result.success) {
        setTxStatus({ loading: false, message: `${leaseUuids.length} lease(s) closed! Tx: ${result.transactionHash}` });
        setSelectedActiveLeases(new Set());
        await fetchData();
      } else {
        setTxStatus({ loading: false, message: `Failed: ${result.error}` });
      }
    } catch (err) {
      setTxStatus({ loading: false, message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` });
    }
  };

  const handleBatchWithdraw = async () => {
    if (!address || selectedActiveLeases.size === 0) return;

    try {
      const signer = getOfflineSigner();
      const leaseUuids = Array.from(selectedActiveLeases);
      setTxStatus({ loading: true, message: `Withdrawing from ${leaseUuids.length} lease(s)...` });

      const result: TxResult = await withdrawFromLeases(signer, address, leaseUuids);

      if (result.success) {
        setTxStatus({ loading: false, message: `Withdrawal from ${leaseUuids.length} lease(s) successful! Tx: ${result.transactionHash}` });
        setSelectedActiveLeases(new Set());
        await fetchData();
      } else {
        setTxStatus({ loading: false, message: `Failed: ${result.error}` });
      }
    } catch (err) {
      setTxStatus({ loading: false, message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` });
    }
  };

  // Selection helpers
  const togglePendingSelection = (uuid: string) => {
    setSelectedPendingLeases((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  };

  const toggleActiveSelection = (uuid: string) => {
    setSelectedActiveLeases((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  };

  const selectAllPending = () => setSelectedPendingLeases(new Set(pendingLeases.map((l) => l.uuid)));
  const deselectAllPending = () => setSelectedPendingLeases(new Set());
  const selectAllActive = () => setSelectedActiveLeases(new Set(activeLeases.map((l) => l.uuid)));
  const deselectAllActive = () => setSelectedActiveLeases(new Set());

  if (!isWalletConnected) {
    return (
      <div className="card-static p-12 text-center">
        <div className="mb-6 text-6xl">🏢</div>
        <h2 className="mb-4 text-2xl font-heading font-semibold">Connect Your Wallet</h2>
        <p className="mb-8 text-muted">Connect your wallet to view your provider dashboard</p>
        <button onClick={() => openView()} className="btn btn-primary btn-lg btn-pill">
          Connect Wallet
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-muted animate-pulse">Loading provider data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card-static p-4 border-error-500/50 bg-error-500/10">
        <span className="text-error">Error: {error}</span>
        <button onClick={autoRefresh.refresh} className="ml-4 text-primary-400 hover:underline">
          Retry
        </button>
      </div>
    );
  }

  if (!myProvider) {
    return (
      <div className="card-static p-12 text-center">
        <div className="mb-6 text-6xl">🏢</div>
        <h2 className="mb-4 text-2xl font-heading font-semibold">No Provider Found</h2>
        <p className="text-muted">
          Your connected address is not associated with any provider.
        </p>
        <p className="mt-2 text-sm text-dim">
          Connected as: <span className="font-mono">{formatAddress(address || '')}</span>
        </p>
      </div>
    );
  }

  const totalWithdrawable = providerWithdrawable?.amounts || [];

  return (
    <div className="space-y-6">
      {/* Billing Module Status */}
      {isInBillingAllowedList && (
        <div className="card-static p-4 border-primary-500/50 bg-primary-500/10">
          <div className="flex items-center gap-2">
            <span className="text-primary-400">★</span>
            <span className="font-medium text-primary-300">Billing Module Admin</span>
          </div>
          <p className="mt-1 text-sm text-primary-400/80">
            Your wallet is in the billing module allowed list.
          </p>
        </div>
      )}

      {/* Transaction Status */}
      {txStatus && (
        <div
          className={`card-static p-4 ${
            txStatus.loading
              ? 'border-primary-500/50 bg-primary-500/10 text-primary-300'
              : txStatus.message.includes('Failed') || txStatus.message.includes('Error')
              ? 'border-error-500/50 bg-error-500/10 text-error'
              : 'border-success-500/50 bg-success-500/10 text-success'
          }`}
        >
          {txStatus.loading && <span className="mr-2">⏳</span>}
          {txStatus.message}
          {!txStatus.loading && (
            <button
              onClick={() => setTxStatus(null)}
              className="ml-4 text-muted hover:text-primary"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Provider Info Card */}
      <div className="card-static p-6">
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
                <span className="font-mono text-secondary">{formatAddress(myProvider.address)}</span>
              </div>
              <div>
                <span className="text-muted">Payout: </span>
                <span className="font-mono text-secondary">{formatAddress(myProvider.payout_address)}</span>
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
              totalWithdrawable.map((coin, idx) => (
                <div key={idx} className="text-2xl font-bold text-success">
                  {formatPrice(coin.amount, coin.denom)}
                </div>
              ))
            )}
            {activeLeases.length > 0 && totalWithdrawable.length > 0 && (
              <button
                onClick={() => handleWithdraw(activeLeases.map((l) => l.uuid))}
                disabled={txStatus?.loading}
                className="btn btn-success mt-2"
              >
                Withdraw All
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
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
      <div className="card-static p-6">
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
                  disabled={txStatus?.loading}
                  className="btn btn-success btn-sm"
                >
                  Acknowledge {selectedPendingLeases.size}
                </button>
                <button
                  onClick={() => handleBatchReject('')}
                  disabled={txStatus?.loading}
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
          <div className="space-y-3">
            {pendingLeases.map((lease) => (
              <PendingLeaseCard
                key={lease.uuid}
                lease={lease}
                getSKU={getSKU}
                onAcknowledge={handleAcknowledge}
                onReject={handleReject}
                txLoading={txStatus?.loading || false}
                isSelected={selectedPendingLeases.has(lease.uuid)}
                onToggleSelect={() => togglePendingSelection(lease.uuid)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Active Leases */}
      <div className="card-static p-6">
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
                  disabled={txStatus?.loading}
                  className="btn btn-success btn-sm"
                >
                  Withdraw {selectedActiveLeases.size}
                </button>
                <button
                  onClick={() => handleBatchClose()}
                  disabled={txStatus?.loading}
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
          <div className="space-y-3">
            {activeLeases.map((lease) => (
              <ActiveLeaseCard
                key={lease.uuid}
                lease={lease}
                getSKU={getSKU}
                withdrawable={withdrawableAmounts.get(lease.uuid) || []}
                onWithdraw={() => handleWithdraw([lease.uuid])}
                onClose={(reason) => handleCloseLease(lease.uuid, reason)}
                txLoading={txStatus?.loading || false}
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
              Tenant: <span className="font-mono">{formatAddress(lease.tenant)}</span>
            </div>
            <div className="text-xs text-dim">
              Created: {new Date(lease.created_at).toLocaleString()}
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
        {lease.items.map((item, idx) => {
          const sku = getSKU(item.sku_uuid);
          return (
            <div key={idx} className="mt-1 flex justify-between text-sm">
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
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [closeReason, setCloseReason] = useState('');

  const hourlyRate = () => {
    let total = 0;
    let denom = '';
    for (const item of lease.items) {
      const perSecond = parseInt(item.locked_price.amount, 10);
      total += perSecond * parseInt(item.quantity, 10) * 3600;
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
              Tenant: <span className="font-mono">{formatAddress(lease.tenant)}</span>
            </div>
            <div className="text-xs text-dim">
              Active since: {lease.acknowledged_at ? new Date(lease.acknowledged_at).toLocaleString() : '-'}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm text-muted">Withdrawable</div>
          {withdrawable.length === 0 ? (
            <div className="font-bold text-dim">0</div>
          ) : (
            withdrawable.map((coin, idx) => (
              <div key={idx} className="font-bold text-success">
                {formatPrice(coin.amount, coin.denom)}
              </div>
            ))
          )}
          <div className="text-xs text-dim">@ {hourlyRate()}</div>
        </div>
      </div>

      {/* Items */}
      <div className="mt-3 rounded-lg bg-surface-800/50 p-2">
        {lease.items.map((item, idx) => {
          const sku = getSKU(item.sku_uuid);
          return (
            <div key={idx} className="flex justify-between text-sm">
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
