import { useState, useCallback, useRef } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Link, Building2, Shield, Copy, Check, Clock, Zap, Package, ChevronDown, ChevronUp, Plus, X } from 'lucide-react';
import { LeaseState, getLeasesByProvider, getWithdrawableAmount, getProviderWithdrawable, getBillingParams, type Lease, type ProviderWithdrawableResponse } from '../../api/billing';
import { SECONDS_PER_HOUR } from '../../config/constants';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { getProviders, getSKUsByProvider, type Provider, type SKU } from '../../api/sku';
import { acknowledgeLease, rejectLease, withdrawFromLeases, closeLease, createLeaseForTenant, type CreateLeaseResult } from '../../api/tx';
import { DENOM_METADATA, formatPrice } from '../../api/config';
import { isValidManifestAddress } from '../../utils/address';
import { useLeaseItems } from '../../hooks/useLeaseItems';
import { calculateEstimatedCost, isValidLeaseItem } from '../../utils/pricing';
import { formatDate, parseBaseUnits } from '../../utils/format';
import type { Coin } from '../../api/bank';
import { useAutoRefreshContext } from '../../contexts/AutoRefreshContext';
import { useAutoRefreshTab } from '../../hooks/useAutoRefreshTab';
import { useToast } from '../../hooks/useToast';
import { useTxHandler } from '../../hooks/useTxHandler';
import { EmptyState } from '../ui/EmptyState';
import { useBatchSelection } from '../../hooks/useBatchSelection';
import { CHAIN_NAME } from '../../config/chain';


export function ProviderTab() {
  const { address, isWalletConnected, openView } = useChain(CHAIN_NAME);
  const toast = useToast();
  const { txLoading, executeTx } = useTxHandler();
  const { copied, copyToClipboard } = useCopyToClipboard();

  const [myProvider, setMyProvider] = useState<Provider | null>(null);
  const [providerLeases, setProviderLeases] = useState<Lease[]>([]);
  const [providerSKUs, setProviderSKUs] = useState<SKU[]>([]);
  const [withdrawableAmounts, setWithdrawableAmounts] = useState<Map<string, Coin[]>>(new Map());
  const [providerWithdrawable, setProviderWithdrawable] = useState<ProviderWithdrawableResponse | null>(null);
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
                <code className="provider-info-value">{myProvider.payout_address}</code>
                <button
                  onClick={() => copyToClipboard(myProvider.payout_address)}
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
                <code className="provider-info-value provider-info-api">{myProvider.api_url}</code>
                <button
                  onClick={() => copyToClipboard(myProvider.api_url)}
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

interface CreateLeaseForTenantModalProps {
  skus: SKU[];
  onClose: () => void;
  onSubmit: (tenant: string, items: { skuUuid: string; quantity: number }[]) => void | Promise<void>;
  loading: boolean;
}

/**
 * Modal for billing module admins to create leases on behalf of tenants.
 * Note: metaHash parameter is supported by the API but intentionally omitted from
 * this UI for MVP. Add payload input similar to CreateLeaseModal if needed.
 */
function CreateLeaseForTenantModal({ skus, onClose, onSubmit, loading }: CreateLeaseForTenantModalProps) {
  const [tenant, setTenant] = useState('');
  const [tenantTouched, setTenantTouched] = useState(false);
  const { items, addItem, removeItem, updateItem, getItemsForSubmit } = useLeaseItems();
  const [tenantError, setTenantError] = useState<string | null>(null);

  const handleTenantChange = (value: string) => {
    setTenant(value);
    setTenantTouched(true);
    if (!value) {
      setTenantError('Tenant address is required');
    } else if (!isValidManifestAddress(value)) {
      setTenantError('Invalid address format (expected manifest1...)');
    } else {
      setTenantError(null);
    }
  };

  const handleTenantBlur = () => {
    setTenantTouched(true);
    if (!tenant) {
      setTenantError('Tenant address is required');
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // isFormValid ensures all items are valid before button is enabled
    if (tenant && !tenantError) {
      onSubmit(tenant, getItemsForSubmit());
    }
  };

  const estimatedCost = calculateEstimatedCost(items, skus);
  const isFormValid = tenant && !tenantError && items.every(isValidLeaseItem);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="card-static w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between p-4 border-b border-surface-700 bg-surface-900/95 backdrop-blur">
          <h3 className="text-lg font-heading font-semibold">Create Lease for Tenant</h3>
          <button
            onClick={onClose}
            className="text-muted hover:text-primary p-1"
            disabled={loading}
            aria-label="Close modal"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Tenant Address */}
          <div>
            <label className="mb-1 block text-sm text-muted">Tenant Address</label>
            <input
              type="text"
              value={tenant}
              onChange={(e) => handleTenantChange(e.target.value)}
              onBlur={handleTenantBlur}
              placeholder="manifest1..."
              className="input w-full font-mono"
              required
              disabled={loading}
            />
            {tenantTouched && tenantError && (
              <p className="mt-1 text-xs text-error">{tenantError}</p>
            )}
          </div>

          {/* SKU Items */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm text-muted">SKU Items</label>
              <button
                type="button"
                onClick={addItem}
                className="text-sm text-primary-400 hover:text-primary-300"
                disabled={loading}
              >
                + Add Item
              </button>
            </div>
            {skus.length === 0 ? (
              <p className="text-sm text-dim">No active SKUs available</p>
            ) : (
              <div className="space-y-2">
                {items.map((item) => (
                  <div key={item.id} className="flex gap-2">
                    <select
                      value={item.skuUuid}
                      onChange={(e) => updateItem(item.id, 'skuUuid', e.target.value)}
                      className="input select flex-1"
                      required
                      disabled={loading}
                    >
                      <option value="">Select SKU...</option>
                      {skus.map((sku) => (
                        <option key={sku.uuid} value={sku.uuid}>
                          {sku.name} ({formatPrice(sku.base_price.amount, sku.base_price.denom, sku.unit)})
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) =>
                        updateItem(item.id, 'quantity', Math.max(1, parseInt(e.target.value, 10) || 1))
                      }
                      className="input w-20"
                      disabled={loading}
                    />
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeItem(item.id)}
                        className="px-2 text-error hover:text-error/80"
                        disabled={loading}
                      >
                        <X size={16} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Estimated Cost */}
          {estimatedCost && (
            <div className="rounded-lg bg-surface-800/50 p-3">
              <div className="text-sm text-muted">Estimated Cost</div>
              <div className="text-lg font-medium text-success">{estimatedCost}</div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-ghost"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !isFormValid}
              className="btn btn-primary"
            >
              {loading ? 'Creating...' : 'Create Lease'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface ProviderLeaseCardProps {
  lease: Lease;
  type: 'pending' | 'active';
  getSKU: (uuid: string) => SKU | undefined;
  onAcknowledge?: () => void;
  onReject?: (reason: string) => void;
  withdrawable?: Coin[];
  onWithdraw?: () => void;
  onClose?: (reason?: string) => void;
  txLoading: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}

function ProviderLeaseCard({
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

  const hourlyRate = () => {
    let total = 0;
    let denom = '';
    for (const item of lease.items) {
      const perSecond = parseBaseUnits(item.locked_price.amount);
      total += perSecond * parseInt(item.quantity, 10) * SECONDS_PER_HOUR;
      denom = item.locked_price.denom;
    }
    const meta = DENOM_METADATA[denom];
    const symbol = meta?.symbol || denom;
    const exponent = meta?.exponent || 6;
    return `${(total / Math.pow(10, exponent)).toFixed(4)} ${symbol}/hr`;
  };

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
              <span className="provider-lease-detail-value">{formatDate(lease.created_at)}</span>
            </div>
            {type === 'active' && lease.acknowledged_at && (
              <div className="provider-lease-detail">
                <span className="provider-lease-detail-label">Active Since</span>
                <span className="provider-lease-detail-value">{formatDate(lease.acknowledged_at)}</span>
              </div>
            )}
          </div>

          <div className="provider-lease-items">
            <div className="provider-lease-items-title">Requested Items</div>
            {lease.items.map((item) => {
              const sku = getSKU(item.sku_uuid);
              return (
                <div key={`${lease.uuid}-${item.sku_uuid}`} className="provider-lease-item">
                  <span className="provider-lease-item-name">
                    {sku?.name || item.sku_uuid} × {item.quantity}
                  </span>
                  <span className="provider-lease-item-price">
                    {formatPrice(item.locked_price.amount, item.locked_price.denom)}/sec
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
