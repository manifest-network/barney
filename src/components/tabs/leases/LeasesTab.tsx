/**
 * Leases tab - displays and manages user's leases.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Link, Shield, Plus, Check, X } from 'lucide-react';
import { LeaseState, type Lease } from '../../../api/billing';
import { getLeasesByTenant, getBillingParams } from '../../../api/billing';
import { getProviders, getSKUs, type Provider, type SKU } from '../../../api/sku';
import { createLease, cancelLease, closeLease, type CreateLeaseResult } from '../../../api/tx';
import {
  createLeaseDataSignMessage,
  createLeaseDataAuthToken,
  uploadLeaseData,
} from '../../../api/provider-api';
import { toHex } from '../../../utils/hash';
import { LEASE_STATE_TO_FILTER, type LeaseFilterState } from '../../../utils/leaseState';
import { useAutoRefreshContext } from '../../../contexts/AutoRefreshContext';
import { useAutoRefreshTab } from '../../../hooks/useAutoRefreshTab';
import { useToast } from '../../../hooks/useToast';
import { useTxHandler } from '../../../hooks/useTxHandler';
import { useBatchSelection } from '../../../hooks/useBatchSelection';
import { EmptyState } from '../../ui/EmptyState';
import { SkeletonCard } from '../../ui/SkeletonCard';
import { ErrorBanner } from '../../ui/ErrorBanner';
import { Pagination } from '../../ui/Pagination';
import { CHAIN_NAME } from '../../../config/chain';
import { validateSignMessage } from './utils';
import { FilterTabs } from './FilterTabs';
import { LeaseCard } from './LeaseCard';
import { CreateLeaseModal } from './CreateLeaseModal';
import { DEFAULT_PAGE_SIZE } from '../../../config/constants';

export function LeasesTab() {
  const { address, isWalletConnected, openView, signArbitrary } = useChain(CHAIN_NAME);
  const toast = useToast();
  const { txLoading, executeTx } = useTxHandler();

  const [activeFilter, setActiveFilter] = useState<LeaseFilterState>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [showCreateLease, setShowCreateLease] = useState(false);
  const [leases, setLeases] = useState<Lease[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [skus, setSKUs] = useState<SKU[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInAllowedList, setIsInAllowedList] = useState(false);
  const { selected: selectedLeases, toggle: toggleLeaseSelection, selectAll: selectLeases, clear: deselectAll } = useBatchSelection();

  const initialLoadRef = useRef(false);

  const fetchData = useCallback(async () => {
    if (!address) {
      setLeases([]);
      setLoading(false);
      return;
    }

    try {
      if (!initialLoadRef.current) {
        setLoading(true);
      }
      setError(null);

      const [leasesData, providersData, skusData, billingParams] = await Promise.all([
        getLeasesByTenant(address),
        getProviders(true),
        getSKUs(true),
        getBillingParams(),
      ]);

      setLeases(leasesData);
      setProviders(providersData);
      setSKUs(skusData);
      setIsInAllowedList(billingParams.allowedList.includes(address));
      initialLoadRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [address]);

  const { refresh } = useAutoRefreshContext();
  useAutoRefreshTab(fetchData);

  const getSKU = (uuid: string) => skus.find((s) => s.uuid === uuid);
  const getProvider = (uuid: string) => providers.find((p) => p.uuid === uuid);

  // Count leases by state
  const counts = {
    all: leases.length,
    pending: leases.filter((l) => l.state === LeaseState.LEASE_STATE_PENDING).length,
    active: leases.filter((l) => l.state === LeaseState.LEASE_STATE_ACTIVE).length,
    closed: leases.filter((l) => l.state === LeaseState.LEASE_STATE_CLOSED || l.state === LeaseState.LEASE_STATE_EXPIRED).length,
    rejected: leases.filter((l) => l.state === LeaseState.LEASE_STATE_REJECTED).length,
  };

  // Priority order: pending first (new/needs attention), then active, then terminal states
  const STATE_PRIORITY: Record<LeaseState, number> = {
    [LeaseState.LEASE_STATE_PENDING]: 0,
    [LeaseState.LEASE_STATE_ACTIVE]: 1,
    [LeaseState.LEASE_STATE_REJECTED]: 2,
    [LeaseState.LEASE_STATE_CLOSED]: 3,
    [LeaseState.LEASE_STATE_EXPIRED]: 4,
    [LeaseState.LEASE_STATE_UNSPECIFIED]: 5,
    [LeaseState.UNRECOGNIZED]: 5,
  };

  const filteredLeases = (activeFilter === 'all'
    ? leases
    : leases.filter((l) => LEASE_STATE_TO_FILTER[l.state] === activeFilter)
  ).sort((a, b) => {
    // Sort by state priority first
    const priorityDiff = STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state];
    if (priorityDiff !== 0) return priorityDiff;
    // Within same state, sort by createdAt descending (newest first)
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  // Pagination
  const totalPages = Math.ceil(filteredLeases.length / DEFAULT_PAGE_SIZE);
  const paginatedLeases = filteredLeases.slice(
    (currentPage - 1) * DEFAULT_PAGE_SIZE,
    currentPage * DEFAULT_PAGE_SIZE
  );

  // Reset to page 1 when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [activeFilter]);

  const handleCancelLease = async (leaseUuid: string) => {
    await executeTx(
      (signer) => cancelLease(signer, address!, [leaseUuid]),
      { successMessage: (hash) => `Lease cancelled! Tx: ${hash}...`, onSuccess: fetchData }
    );
  };

  const handleCloseLease = async (leaseUuid: string, reason?: string) => {
    await executeTx(
      (signer) => closeLease(signer, address!, [leaseUuid], reason),
      { successMessage: (hash) => `Lease closed! Tx: ${hash}...`, onSuccess: fetchData }
    );
  };

  const handleCreateLease = async (
    items: { skuUuid: string; quantity: number }[],
    payload?: Uint8Array,
    metaHash?: Uint8Array,
    providerUuid?: string
  ) => {
    const result = await executeTx<CreateLeaseResult>(
      (signer) => createLease(signer, address!, items, metaHash),
      {
        showToast: false, // We handle toasts manually for the payload upload flow
        onSuccess: async () => {
          setShowCreateLease(false);
          await fetchData();
        },
      }
    );

    if (!result) return;

    if (result.success) {
      if (payload && metaHash && providerUuid) {
        toast.info('Uploading payload to provider...');

        const provider = providers.find((p) => p.uuid === providerUuid);
        if (!provider?.apiUrl) {
          toast.warning(`Lease created but provider has no API URL. Tx: ${result.transactionHash?.slice(0, 16)}...`);
          return;
        }

        const leaseUuid = result.leaseUuid;
        if (!leaseUuid) {
          toast.warning(`Lease created but couldn't extract UUID from transaction. Tx: ${result.transactionHash?.slice(0, 16)}...`);
          return;
        }

        const metaHashHex = toHex(metaHash);

        try {
          const timestamp = Math.floor(Date.now() / 1000);
          const signMessage = createLeaseDataSignMessage(leaseUuid, metaHashHex, timestamp);

          if (!validateSignMessage(signMessage, 'manifest lease data')) {
            throw new Error('Invalid signature message format');
          }

          const signResult = await signArbitrary(address!, signMessage);

          const authToken = createLeaseDataAuthToken(
            address!,
            leaseUuid,
            metaHashHex,
            timestamp,
            signResult.pub_key.value,
            signResult.signature
          );

          await uploadLeaseData(provider.apiUrl, leaseUuid, payload, authToken);
          toast.success(`Lease created and payload uploaded! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        } catch (uploadErr) {
          toast.error(`Lease created but payload upload failed: ${uploadErr instanceof Error ? uploadErr.message : 'Unknown error'}`);
        }
      } else {
        toast.success(`Lease created! Tx: ${result.transactionHash?.slice(0, 16)}...`);
      }
    } else {
      toast.error(`Failed: ${result.error}`);
    }
  };

  // Batch operations
  const handleBatchCancel = async () => {
    if (selectedLeases.size === 0) return;

    const pendingSelected = Array.from(selectedLeases).filter((uuid) => {
      const lease = leases.find((l) => l.uuid === uuid);
      return lease?.state === LeaseState.LEASE_STATE_PENDING;
    });

    if (pendingSelected.length === 0) {
      toast.warning('No pending leases selected');
      return;
    }

    await executeTx(
      (signer) => cancelLease(signer, address!, pendingSelected),
      {
        successMessage: (hash) => `${pendingSelected.length} lease(s) cancelled! Tx: ${hash}...`,
        onSuccess: async () => {
          deselectAll();
          await fetchData();
        },
      }
    );
  };

  const handleBatchClose = async () => {
    if (selectedLeases.size === 0) return;

    const activeSelected = Array.from(selectedLeases).filter((uuid) => {
      const lease = leases.find((l) => l.uuid === uuid);
      return lease?.state === LeaseState.LEASE_STATE_ACTIVE;
    });

    if (activeSelected.length === 0) {
      toast.warning('No active leases selected');
      return;
    }

    await executeTx(
      (signer) => closeLease(signer, address!, activeSelected),
      {
        successMessage: (hash) => `${activeSelected.length} lease(s) closed! Tx: ${hash}...`,
        onSuccess: async () => {
          deselectAll();
          await fetchData();
        },
      }
    );
  };

  // Count actionable (selectable) leases - from current page only
  const actionableLeases = paginatedLeases.filter(
    (l) => l.state === LeaseState.LEASE_STATE_PENDING || l.state === LeaseState.LEASE_STATE_ACTIVE
  );

  const handleSelectAll = () => {
    selectLeases(actionableLeases.map((l) => l.uuid));
  };

  // Count selected by state
  const selectedPendingCount = Array.from(selectedLeases).filter((uuid) => {
    const lease = leases.find((l) => l.uuid === uuid);
    return lease?.state === LeaseState.LEASE_STATE_PENDING;
  }).length;

  const selectedActiveCount = Array.from(selectedLeases).filter((uuid) => {
    const lease = leases.find((l) => l.uuid === uuid);
    return lease?.state === LeaseState.LEASE_STATE_ACTIVE;
  }).length;

  if (!isWalletConnected) {
    return (
      <EmptyState
        icon={Link}
        title="Connect Your Wallet"
        description="Connect your wallet to view and manage your leases"
        action={{ label: 'Connect Wallet', onClick: () => openView() }}
      />
    );
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-10 w-full max-w-xl" />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (error) {
    return <ErrorBanner error={error} onRetry={refresh} />;
  }

  return (
    <div className="space-y-4">
      {/* Admin Badge */}
      {isInAllowedList && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-primary-500/50 bg-primary-500/10">
          <Shield size={14} className="text-primary-400" />
          <span className="text-sm font-medium text-primary-300">Billing Module Admin</span>
        </div>
      )}

      {/* Header with Filter Tabs and Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterTabs
          activeFilter={activeFilter}
          onChange={setActiveFilter}
          counts={counts}
        />
        <button
          onClick={() => setShowCreateLease(true)}
          disabled={providers.length === 0}
          className="btn btn-primary btn-sm"
        >
          <Plus size={14} />
          New Lease
        </button>
      </div>

      {/* Selection hint for actionable leases */}
      {actionableLeases.length > 0 && selectedLeases.size === 0 && (
        <div className="text-xs text-dim">
          <button
            onClick={handleSelectAll}
            className="text-primary-400 hover:text-primary-300"
          >
            Select all {actionableLeases.length} actionable lease{actionableLeases.length !== 1 ? 's' : ''}
          </button>
        </div>
      )}

      {/* Leases List */}
      <div className="space-y-2">
        {filteredLeases.length === 0 ? (
          <div className="card-static p-8 text-center">
            <p className="text-muted mb-2">
              {activeFilter === 'all' ? 'No leases yet' : `No ${activeFilter} leases`}
            </p>
            {providers.length > 0 && activeFilter === 'all' && (
              <button
                onClick={() => setShowCreateLease(true)}
                className="text-sm text-primary-400 hover:text-primary-300"
              >
                Create your first lease
              </button>
            )}
          </div>
        ) : (
          paginatedLeases.map((lease) => (
            <LeaseCard
              key={lease.uuid}
              lease={lease}
              getSKU={getSKU}
              getProvider={getProvider}
              onCancel={handleCancelLease}
              onClose={handleCloseLease}
              txLoading={txLoading}
              tenantAddress={address}
              isSelected={selectedLeases.has(lease.uuid)}
              onToggleSelect={() => toggleLeaseSelection(lease.uuid)}
            />
          ))
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={filteredLeases.length}
          itemsPerPage={DEFAULT_PAGE_SIZE}
          onPageChange={setCurrentPage}
        />
      )}

      {/* Floating Batch Action Bar */}
      {selectedLeases.size > 0 && (
        <div className="floating-action-bar-wrapper">
          <div className="floating-action-bar">
            <div className="floating-action-bar-count">
              <span className="floating-action-bar-check">
                <Check size={12} />
              </span>
              {selectedLeases.size} selected
            </div>
            <div className="floating-action-bar-actions">
              {selectedPendingCount > 0 && (
                <button
                  onClick={handleBatchCancel}
                  disabled={txLoading}
                  className="btn btn-danger btn-sm"
                >
                  Cancel {selectedPendingCount}
                </button>
              )}
              {selectedActiveCount > 0 && (
                <button
                  onClick={handleBatchClose}
                  disabled={txLoading}
                  className="btn btn-secondary btn-sm"
                >
                  Close {selectedActiveCount}
                </button>
              )}
            </div>
            <button
              onClick={deselectAll}
              className="floating-action-bar-clear"
              title="Clear selection"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Create Lease Modal */}
      {showCreateLease && (
        <CreateLeaseModal
          providers={providers}
          skus={skus}
          onClose={() => setShowCreateLease(false)}
          onSubmit={handleCreateLease}
          loading={txLoading}
        />
      )}
    </div>
  );
}
