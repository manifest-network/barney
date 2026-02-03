import { useState, useCallback, useRef } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Link, Building2, Shield, Copy, Check, Clock, Zap, Package, Plus } from 'lucide-react';
import { LeaseState, getLeasesByProvider, getWithdrawableAmount, getProviderWithdrawable, getBillingParams, type Lease, type QueryProviderWithdrawableResponse } from '../../../api/billing';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import { getProviders, getSKUsByProvider, type Provider, type SKU } from '../../../api/sku';
import { acknowledgeLease, rejectLease, withdrawFromLeases, closeLease, createLeaseForTenant, type CreateLeaseResult } from '../../../api/tx';
import { formatPrice } from '../../../api/config';
import { isValidManifestAddress } from '../../../utils/address';
import type { Coin } from '../../../api/bank';
import { useAutoRefreshContext } from '../../../contexts/AutoRefreshContext';
import { useAutoRefreshTab } from '../../../hooks/useAutoRefreshTab';
import { useToast } from '../../../hooks/useToast';
import { useTxHandler } from '../../../hooks/useTxHandler';
import { EmptyState } from '../../ui/EmptyState';
import { useBatchSelection } from '../../../hooks/useBatchSelection';
import { CHAIN_NAME } from '../../../config/chain';
import { CreateLeaseForTenantModal } from './CreateLeaseForTenantModal';
import { ProviderLeaseCard } from './ProviderLeaseCard';

export function ProviderTab() {
  const { address, isWalletConnected, openView } = useChain(CHAIN_NAME);
  const toast = useToast();
  const { txLoading, executeTx } = useTxHandler();
  const { copied, copyToClipboard } = useCopyToClipboard();

  const [myProvider, setMyProvider] = useState<Provider | null>(null);
  const [providerLeases, setProviderLeases] = useState<Lease[]>([]);
  const [providerSKUs, setProviderSKUs] = useState<SKU[]>([]);
  const [withdrawableAmounts, setWithdrawableAmounts] = useState<Map<string, Coin[]>>(new Map());
  const [providerWithdrawable, setProviderWithdrawable] = useState<QueryProviderWithdrawableResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInBillingAllowedList, setIsInBillingAllowedList] = useState(false);
  const [showCreateLeaseForTenant, setShowCreateLeaseForTenant] = useState(false);
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
      setIsInBillingAllowedList(billingParams.allowedList.includes(address));

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

  const { refresh } = useAutoRefreshContext();
  useAutoRefreshTab(fetchData);

  const pendingLeases = providerLeases.filter((l) => l.state === LeaseState.LEASE_STATE_PENDING);
  const activeLeases = providerLeases.filter((l) => l.state === LeaseState.LEASE_STATE_ACTIVE);

  const handleAcknowledge = async (leaseUuid: string) => {
    await executeTx(
      (signer) => acknowledgeLease(signer, address!, [leaseUuid]),
      { successMessage: (hash) => `Lease acknowledged! Tx: ${hash}...`, onSuccess: fetchData }
    );
  };

  const handleReject = async (leaseUuid: string, reason: string) => {
    await executeTx(
      (signer) => rejectLease(signer, address!, [leaseUuid], reason),
      { successMessage: (hash) => `Lease rejected! Tx: ${hash}...`, onSuccess: fetchData }
    );
  };

  const handleWithdraw = async (leaseUuids: string[]) => {
    await executeTx(
      (signer) => withdrawFromLeases(signer, address!, leaseUuids),
      { successMessage: (hash) => `Withdrawal successful! Tx: ${hash}...`, onSuccess: fetchData }
    );
  };

  const handleCloseLease = async (leaseUuid: string, reason?: string) => {
    await executeTx(
      (signer) => closeLease(signer, address!, [leaseUuid], reason),
      { successMessage: (hash) => `Lease closed! Tx: ${hash}...`, onSuccess: fetchData }
    );
  };

  const getSKU = (uuid: string) => providerSKUs.find((s) => s.uuid === uuid);

  // Batch operations
  const handleBatchAcknowledge = async () => {
    if (selectedPendingLeases.size === 0) return;
    const leaseUuids = Array.from(selectedPendingLeases);

    await executeTx(
      (signer) => acknowledgeLease(signer, address!, leaseUuids),
      {
        successMessage: (hash) => `${leaseUuids.length} lease(s) acknowledged! Tx: ${hash}...`,
        onSuccess: async () => {
          deselectAllPending();
          await fetchData();
        },
      }
    );
  };

  const handleBatchReject = async (reason: string) => {
    if (selectedPendingLeases.size === 0) return;
    const leaseUuids = Array.from(selectedPendingLeases);

    await executeTx(
      (signer) => rejectLease(signer, address!, leaseUuids, reason),
      {
        successMessage: (hash) => `${leaseUuids.length} lease(s) rejected! Tx: ${hash}...`,
        onSuccess: async () => {
          deselectAllPending();
          await fetchData();
        },
      }
    );
  };

  const handleBatchClose = async (reason?: string) => {
    if (selectedActiveLeases.size === 0) return;
    const leaseUuids = Array.from(selectedActiveLeases);

    await executeTx(
      (signer) => closeLease(signer, address!, leaseUuids, reason),
      {
        successMessage: (hash) => `${leaseUuids.length} lease(s) closed! Tx: ${hash}...`,
        onSuccess: async () => {
          deselectAllActive();
          await fetchData();
        },
      }
    );
  };

  const handleBatchWithdraw = async () => {
    if (selectedActiveLeases.size === 0) return;
    const leaseUuids = Array.from(selectedActiveLeases);

    await executeTx(
      (signer) => withdrawFromLeases(signer, address!, leaseUuids),
      {
        successMessage: (hash) => `Withdrawal from ${leaseUuids.length} lease(s) successful! Tx: ${hash}...`,
        onSuccess: async () => {
          deselectAllActive();
          await fetchData();
        },
      }
    );
  };

  const selectAllPending = () => selectAllPendingIds(pendingLeases.map((l) => l.uuid));
  const selectAllActive = () => selectAllActiveIds(activeLeases.map((l) => l.uuid));

  const handleCreateLeaseForTenant = async (tenant: string, items: { skuUuid: string; quantity: number }[]) => {
    if (!isValidManifestAddress(tenant)) {
      toast.error('Invalid tenant address format.');
      return;
    }

    const result = await executeTx<CreateLeaseResult>(
      (signer) => createLeaseForTenant(signer, address!, tenant, items),
      {
        showToast: false, // We handle custom toast with UUID display
        onSuccess: async () => {
          setShowCreateLeaseForTenant(false);
          await fetchData();
        },
      }
    );

    if (!result) return;

    if (result.success) {
      const uuidDisplay = result.leaseUuid ? `UUID: ${result.leaseUuid.slice(0, 8)}...` : '';
      const txDisplay = result.transactionHash ? `Tx: ${result.transactionHash.slice(0, 16)}...` : '';
      toast.success(`Lease created for tenant! ${uuidDisplay} ${txDisplay}`.trim());
    } else {
      toast.error(`Failed: ${result.error}`);
    }
  };

  const activeSKUs = providerSKUs.filter((s) => s.active);

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
      <div className="provider-dashboard">
        <div className="provider-skeleton-grid">
          <div className="skeleton provider-skeleton-info" />
          <div className="skeleton provider-skeleton-earnings" />
        </div>
        <div className="provider-skeleton-stats">
          <div className="skeleton provider-skeleton-stat" />
          <div className="skeleton provider-skeleton-stat" />
          <div className="skeleton provider-skeleton-stat" />
        </div>
        <div className="skeleton provider-skeleton-leases" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="provider-error">
        <span>{error}</span>
        <button onClick={refresh} className="btn btn-ghost btn-xs">
          Retry
        </button>
      </div>
    );
  }

  if (!myProvider) {
    return (
      <EmptyState
        icon={Building2}
        title="No Provider Found"
        description="Your connected address is not associated with any provider."
      />
    );
  }

  const totalWithdrawable = providerWithdrawable?.amounts || [];

  return (
    <div className="provider-dashboard">
      {/* Billing Module Admin Section */}
      {isInBillingAllowedList && (
        <div className="provider-admin-section">
          <div className="provider-admin-badge">
            <Shield size={14} />
            <span>Billing Module Admin</span>
          </div>
          <button
            onClick={() => setShowCreateLeaseForTenant(true)}
            disabled={txLoading || activeSKUs.length === 0}
            className="btn btn-secondary btn-sm"
          >
            <Plus size={14} />
            Create Lease for Tenant
          </button>
        </div>
      )}

      {/* Top Row: Provider Info + Earnings */}
      <div className="provider-top-row">
        {/* Provider Info Card */}
        <div className="provider-info-card">
          <div className="provider-info-header">
            <div className="provider-info-title">
              <Building2 size={14} />
              Your Provider
            </div>
            <span className={`provider-status-badge ${myProvider.active ? 'active' : 'inactive'}`}>
              {myProvider.active ? 'Active' : 'Inactive'}
            </span>
          </div>
          <div className="provider-info-body">
            <div className="provider-info-field">
              <span className="provider-info-label">UUID</span>
              <div className="provider-info-value-row">
                <code className="provider-info-value">{myProvider.uuid}</code>
                <button
                  onClick={() => copyToClipboard(myProvider.uuid)}
                  className="provider-info-copy"
                  title="Copy UUID"
                >
                  {copied ? <Check size={10} /> : <Copy size={10} />}
                </button>
              </div>
            </div>
            <div className="provider-info-field">
              <span className="provider-info-label">Management Address</span>
              <div className="provider-info-value-row">
                <code className="provider-info-value">{myProvider.address}</code>
                <button
                  onClick={() => copyToClipboard(myProvider.address)}
                  className="provider-info-copy"
                  title="Copy Address"
                >
                  {copied ? <Check size={10} /> : <Copy size={10} />}
                </button>
              </div>
            </div>
            <div className="provider-info-field">
              <span className="provider-info-label">Payout Address</span>
              <div className="provider-info-value-row">
                <code className="provider-info-value">{myProvider.payoutAddress}</code>
                <button
                  onClick={() => copyToClipboard(myProvider.payoutAddress)}
                  className="provider-info-copy"
                  title="Copy Payout Address"
                >
                  {copied ? <Check size={10} /> : <Copy size={10} />}
                </button>
              </div>
            </div>
            <div className="provider-info-field">
              <span className="provider-info-label">API URL</span>
              <div className="provider-info-value-row">
                <code className="provider-info-value provider-info-api">{myProvider.apiUrl}</code>
                <button
                  onClick={() => copyToClipboard(myProvider.apiUrl)}
                  className="provider-info-copy"
                  title="Copy API URL"
                >
                  {copied ? <Check size={10} /> : <Copy size={10} />}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Earnings Card */}
        <div className="provider-earnings-card">
          <div className="provider-earnings-header">
            <span className="provider-earnings-title">
              <Zap size={14} />
              Total Withdrawable
            </span>
          </div>
          <div className="provider-earnings-body">
            <div className="provider-earnings-amount">
              {totalWithdrawable.length === 0 ? (
                <span className="provider-earnings-value empty">0 PWR</span>
              ) : (
                totalWithdrawable.map((coin) => (
                  <span key={coin.denom} className="provider-earnings-value">
                    {formatPrice(coin.amount, coin.denom)}
                  </span>
                ))
              )}
            </div>
            {activeLeases.length > 0 && totalWithdrawable.length > 0 && (
              <button
                onClick={() => handleWithdraw(activeLeases.map((l) => l.uuid))}
                disabled={txLoading}
                className="provider-withdraw-all-btn"
              >
                Withdraw All
              </button>
            )}
            <div className="provider-earnings-hint">
              From {activeLeases.length} active lease{activeLeases.length !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
      </div>

      {/* Stats Row */}
      <div className="provider-stats-row">
        <div className="provider-stat" data-type="pending">
          <div className="provider-stat-icon">
            <Clock size={16} />
          </div>
          <div className="provider-stat-content">
            <span className="provider-stat-value">{pendingLeases.length}</span>
            <span className="provider-stat-label">Pending</span>
          </div>
        </div>
        <div className="provider-stat" data-type="active">
          <div className="provider-stat-icon">
            <Zap size={16} />
          </div>
          <div className="provider-stat-content">
            <span className="provider-stat-value">{activeLeases.length}</span>
            <span className="provider-stat-label">Active</span>
          </div>
        </div>
        <div className="provider-stat" data-type="skus">
          <div className="provider-stat-icon">
            <Package size={16} />
          </div>
          <div className="provider-stat-content">
            <span className="provider-stat-value">{providerSKUs.filter((s) => s.active).length}</span>
            <span className="provider-stat-label">SKUs</span>
          </div>
        </div>
      </div>

      {/* Pending Leases Section */}
      <div className="provider-section">
        <div className="provider-section-header">
          <div className="provider-section-title">
            <Clock size={14} />
            Pending Leases
            {pendingLeases.length > 0 && (
              <span className="provider-section-count" data-type="pending">{pendingLeases.length}</span>
            )}
          </div>
          {pendingLeases.length > 0 && (
            <div className="provider-batch-controls">
              <button onClick={selectAllPending} className="provider-select-btn">
                Select all {pendingLeases.length}
              </button>
              {selectedPendingLeases.size > 0 && (
                <>
                  <button onClick={deselectAllPending} className="provider-select-btn">
                    Clear
                  </button>
                  <div className="provider-batch-actions">
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
                </>
              )}
            </div>
          )}
        </div>

        <div className="provider-leases-list">
          {pendingLeases.length === 0 ? (
            <div className="provider-empty-message">No pending leases to review</div>
          ) : (
            pendingLeases.map((lease) => (
              <ProviderLeaseCard
                key={lease.uuid}
                lease={lease}
                type="pending"
                getSKU={getSKU}
                onAcknowledge={() => handleAcknowledge(lease.uuid)}
                onReject={(reason) => handleReject(lease.uuid, reason)}
                txLoading={txLoading}
                isSelected={selectedPendingLeases.has(lease.uuid)}
                onToggleSelect={() => togglePendingSelection(lease.uuid)}
              />
            ))
          )}
        </div>
      </div>

      {/* Active Leases Section */}
      <div className="provider-section">
        <div className="provider-section-header">
          <div className="provider-section-title">
            <Zap size={14} />
            Active Leases
            {activeLeases.length > 0 && (
              <span className="provider-section-count" data-type="active">{activeLeases.length}</span>
            )}
          </div>
          {activeLeases.length > 0 && (
            <div className="provider-batch-controls">
              <button onClick={selectAllActive} className="provider-select-btn">
                Select all {activeLeases.length}
              </button>
              {selectedActiveLeases.size > 0 && (
                <>
                  <button onClick={deselectAllActive} className="provider-select-btn">
                    Clear
                  </button>
                  <div className="provider-batch-actions">
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
                      className="btn btn-ghost btn-sm"
                    >
                      Close {selectedActiveLeases.size}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="provider-leases-list">
          {activeLeases.length === 0 ? (
            <div className="provider-empty-message">No active leases</div>
          ) : (
            activeLeases.map((lease) => (
              <ProviderLeaseCard
                key={lease.uuid}
                lease={lease}
                type="active"
                getSKU={getSKU}
                withdrawable={withdrawableAmounts.get(lease.uuid) || []}
                onWithdraw={() => handleWithdraw([lease.uuid])}
                onClose={(reason) => handleCloseLease(lease.uuid, reason)}
                txLoading={txLoading}
                isSelected={selectedActiveLeases.has(lease.uuid)}
                onToggleSelect={() => toggleActiveSelection(lease.uuid)}
              />
            ))
          )}
        </div>
      </div>

      {/* Create Lease For Tenant Modal */}
      {showCreateLeaseForTenant && (
        <CreateLeaseForTenantModal
          skus={activeSKUs}
          onClose={() => setShowCreateLeaseForTenant(false)}
          onSubmit={handleCreateLeaseForTenant}
          loading={txLoading}
        />
      )}
    </div>
  );
}
