import { useState, useEffect, useCallback, useRef } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Link, Shield, Plus, ChevronDown, ChevronUp, Clock, Copy, Check, X, ExternalLink, Zap, MinusCircle, XCircle, Wifi } from 'lucide-react';
import { LeaseState, type Lease } from '../../api/billing';
import { SECONDS_PER_HOUR } from '../../config/constants';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { truncateAddress } from '../../utils/address';
import { formatDate, formatRelativeTime, formatDuration } from '../../utils/format';
import { LEASE_STATE_LABELS, LEASE_STATE_TO_FILTER, type LeaseFilterState } from '../../utils/leaseState';
import { getLeasesByTenant, getBillingParams } from '../../api/billing';
import { getProviders, getSKUs, type Provider, type SKU } from '../../api/sku';
import { createLease, cancelLease, closeLease, type TxResult, type CreateLeaseResult } from '../../api/tx';
import { DENOM_METADATA, formatPrice } from '../../api/config';
import { useLeaseItems } from '../../hooks/useLeaseItems';
import { calculateEstimatedCost, isValidLeaseItem } from '../../utils/pricing';
import {
  createSignMessage,
  createAuthToken,
  createLeaseDataSignMessage,
  createLeaseDataAuthToken,
  getLeaseConnectionInfo,
  uploadLeaseData,
  type LeaseInfo,
} from '../../api/provider-api';
import { sha256, toHex, validatePayloadSize, getPayloadSize, MAX_PAYLOAD_SIZE } from '../../utils/hash';
import { validateFile } from '../../utils/fileValidation';
import { useAutoRefreshContext } from '../../contexts/AutoRefreshContext';
import { useToast } from '../../hooks/useToast';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonCard } from '../ui/SkeletonCard';
import { ErrorBanner } from '../ui/ErrorBanner';
import { Pagination } from '../ui/Pagination';
import { useBatchSelection } from '../../hooks/useBatchSelection';

/**
 * Validates a signature message before signing with the user's wallet.
 */
function validateSignMessage(message: string, expectedPrefix: string): boolean {
  if (!message || typeof message !== 'string') return false;
  if (!message.startsWith(expectedPrefix)) return false;
  const safePattern = /^[a-zA-Z0-9\s:-]+$/;
  return safePattern.test(message);
}

const CHAIN_NAME = 'manifestlocal';

const LEASES_PER_PAGE = 10;

export function LeasesTab() {
  const { address, isWalletConnected, openView, getOfflineSigner, signArbitrary } = useChain(CHAIN_NAME);
  const toast = useToast();

  const [activeFilter, setActiveFilter] = useState<LeaseFilterState>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [showCreateLease, setShowCreateLease] = useState(false);
  const [leases, setLeases] = useState<Lease[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [skus, setSKUs] = useState<SKU[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInAllowedList, setIsInAllowedList] = useState(false);
  const [txLoading, setTxLoading] = useState(false);
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
      setIsInAllowedList(billingParams.allowed_list.includes(address));
      initialLoadRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [address]);

  const { registerFetchFn, unregisterFetchFn, refresh } = useAutoRefreshContext();

  useEffect(() => {
    registerFetchFn(fetchData);
    return () => unregisterFetchFn();
  }, [fetchData, registerFetchFn, unregisterFetchFn]);

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
    // Within same state, sort by created_at descending (newest first)
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  // Pagination
  const totalPages = Math.ceil(filteredLeases.length / LEASES_PER_PAGE);
  const paginatedLeases = filteredLeases.slice(
    (currentPage - 1) * LEASES_PER_PAGE,
    currentPage * LEASES_PER_PAGE
  );

  // Reset to page 1 when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [activeFilter]);

  const handleCancelLease = async (leaseUuid: string) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxLoading(true);

      const result: TxResult = await cancelLease(signer, address, [leaseUuid]);

      if (result.success) {
        toast.success(`Lease cancelled! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        await fetchData();
      } else {
        toast.error(`Failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
      toast.error(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTxLoading(false);
    }
  };

  const handleCreateLease = async (
    items: { skuUuid: string; quantity: number }[],
    payload?: Uint8Array,
    metaHash?: Uint8Array,
    providerUuid?: string
  ) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxLoading(true);

      const result: CreateLeaseResult = await createLease(signer, address, items, metaHash);

      if (result.success) {
        if (payload && metaHash && providerUuid) {
          toast.info('Uploading payload to provider...');

          const provider = providers.find((p) => p.uuid === providerUuid);
          if (!provider?.api_url) {
            toast.warning(`Lease created but provider has no API URL. Tx: ${result.transactionHash?.slice(0, 16)}...`);
            setShowCreateLease(false);
            await fetchData();
            return;
          }

          const leaseUuid = result.leaseUuid;
          if (!leaseUuid) {
            toast.warning(`Lease created but couldn't extract UUID from transaction. Tx: ${result.transactionHash?.slice(0, 16)}...`);
            setShowCreateLease(false);
            await fetchData();
            return;
          }

          const metaHashHex = toHex(metaHash);

          try {
            const timestamp = Math.floor(Date.now() / 1000);
            const signMessage = createLeaseDataSignMessage(leaseUuid, metaHashHex, timestamp);

            if (!validateSignMessage(signMessage, 'manifest lease data')) {
              throw new Error('Invalid signature message format');
            }

            const signResult = await signArbitrary(address, signMessage);

            const authToken = createLeaseDataAuthToken(
              address,
              leaseUuid,
              metaHashHex,
              timestamp,
              signResult.pub_key.value,
              signResult.signature
            );

            await uploadLeaseData(provider.api_url, leaseUuid, payload, authToken);
            toast.success(`Lease created and payload uploaded! Tx: ${result.transactionHash?.slice(0, 16)}...`);
          } catch (uploadErr) {
            toast.error(`Lease created but payload upload failed: ${uploadErr instanceof Error ? uploadErr.message : 'Unknown error'}`);
          }
        } else {
          toast.success(`Lease created! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        }
        setShowCreateLease(false);
        await fetchData();
      } else {
        toast.error(`Failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTxLoading(false);
    }
  };

  // Batch operations
  const handleBatchCancel = async () => {
    if (!address || selectedLeases.size === 0) return;

    const pendingSelected = Array.from(selectedLeases).filter((uuid) => {
      const lease = leases.find((l) => l.uuid === uuid);
      return lease?.state === LeaseState.LEASE_STATE_PENDING;
    });

    if (pendingSelected.length === 0) {
      toast.warning('No pending leases selected');
      return;
    }

    try {
      const signer = getOfflineSigner();
      setTxLoading(true);

      const result: TxResult = await cancelLease(signer, address, pendingSelected);

      if (result.success) {
        toast.success(`${pendingSelected.length} lease(s) cancelled! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        deselectAll();
        await fetchData();
      } else {
        toast.error(`Failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTxLoading(false);
    }
  };

  const handleBatchClose = async () => {
    if (!address || selectedLeases.size === 0) return;

    const activeSelected = Array.from(selectedLeases).filter((uuid) => {
      const lease = leases.find((l) => l.uuid === uuid);
      return lease?.state === LeaseState.LEASE_STATE_ACTIVE;
    });

    if (activeSelected.length === 0) {
      toast.warning('No active leases selected');
      return;
    }

    try {
      const signer = getOfflineSigner();
      setTxLoading(true);

      const result: TxResult = await closeLease(signer, address, activeSelected);

      if (result.success) {
        toast.success(`${activeSelected.length} lease(s) closed! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        deselectAll();
        await fetchData();
      } else {
        toast.error(`Failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTxLoading(false);
    }
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
          itemsPerPage={LEASES_PER_PAGE}
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

/* ============================================
   FILTER TABS COMPONENT
   ============================================ */
function FilterTabs({
  activeFilter,
  onChange,
  counts,
}: {
  activeFilter: LeaseFilterState;
  onChange: (filter: LeaseFilterState) => void;
  counts: Record<LeaseFilterState, number>;
}) {
  const filters: { key: LeaseFilterState; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'pending', label: 'Pending' },
    { key: 'active', label: 'Active' },
    { key: 'closed', label: 'Closed' },
    { key: 'rejected', label: 'Rejected' },
  ];

  return (
    <div className="filter-tabs">
      {filters.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`filter-tab ${activeFilter === key ? 'active' : ''}`}
          data-state={key}
          data-has-items={counts[key] > 0 ? 'true' : 'false'}
        >
          {label}
          <span className="filter-tab-count">{counts[key]}</span>
        </button>
      ))}
    </div>
  );
}

/* ============================================
   JSON RENDERER (for arbitrary lease info)
   ============================================ */

/**
 * Recursively renders JSON data in a compact, readable format.
 * Handles primitives, arrays, and nested objects.
 */
function JsonRenderer({
  data,
  copyToClipboard,
  depth = 0,
}: {
  data: unknown;
  copyToClipboard: (text: string) => void;
  depth?: number;
}) {
  // Primitives: string, number, boolean, null
  if (data === null || data === undefined) {
    return <span className="lease-info-null">null</span>;
  }

  if (typeof data === 'boolean') {
    return <span className={`lease-info-bool lease-info-bool-${data}`}>{data ? 'true' : 'false'}</span>;
  }

  if (typeof data === 'number') {
    return <span className="lease-info-number">{data}</span>;
  }

  if (typeof data === 'string') {
    // Check if it looks like a URL
    const isUrl = /^https?:\/\//.test(data);
    return (
      <span className="lease-info-string-container">
        <code className="lease-info-value">{data}</code>
        <button
          onClick={() => copyToClipboard(data)}
          className="lease-card-copy-btn"
          title="Copy"
        >
          <Copy size={10} />
        </button>
        {isUrl && (
          <a
            href={data}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost btn-xs"
            title="Open in new tab"
          >
            <ExternalLink size={12} />
          </a>
        )}
      </span>
    );
  }

  // Arrays
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <span className="lease-info-empty">[]</span>;
    }
    return (
      <div className="lease-info-array">
        {data.map((item, idx) => (
          <div key={idx} className="lease-info-array-item">
            <span className="lease-info-array-index">[{idx}]</span>
            <JsonRenderer data={item} copyToClipboard={copyToClipboard} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  // Objects
  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return <span className="lease-info-empty">{'{}'}</span>;
    }
    return (
      <div className={`lease-info-object ${depth > 0 ? 'lease-info-nested' : ''}`}>
        {entries.map(([key, value]) => {
          const isSimpleValue = value === null || typeof value !== 'object';
          return (
            <div key={key} className={`lease-info-row ${!isSimpleValue ? 'lease-info-row-complex' : ''}`}>
              <span className="lease-info-label">{formatKey(key)}</span>
              <JsonRenderer data={value} copyToClipboard={copyToClipboard} depth={depth + 1} />
            </div>
          );
        })}
      </div>
    );
  }

  // Fallback for unknown types
  return <span className="lease-info-unknown">{String(data)}</span>;
}

/**
 * Formats a camelCase or snake_case key into a readable label.
 */
function formatKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ============================================
   LEASE CARD COMPONENT
   ============================================ */

// State icons
const STATE_ICONS: Record<LeaseFilterState, React.ReactNode> = {
  all: null,
  pending: <Clock size={12} />,
  active: <Zap size={12} />,
  closed: <MinusCircle size={12} />,
  rejected: <XCircle size={12} />,
};

function LeaseCard({
  lease,
  getSKU,
  getProvider,
  onCancel,
  onClose,
  txLoading,
  tenantAddress,
  isSelected,
  onToggleSelect,
}: {
  lease: Lease;
  getSKU: (uuid: string) => SKU | undefined;
  getProvider: (uuid: string) => Provider | undefined;
  onCancel: (uuid: string) => void;
  onClose: (uuid: string, reason?: string) => void;
  txLoading: boolean;
  tenantAddress?: string;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}) {
  const { signArbitrary } = useChain(CHAIN_NAME);
  const { copied, copyToClipboard } = useCopyToClipboard();

  const [isExpanded, setIsExpanded] = useState(false);
  const [leaseInfo, setLeaseInfo] = useState<LeaseInfo | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [closeReason, setCloseReason] = useState('');

  const provider = getProvider(lease.provider_uuid);
  const stateKey = LEASE_STATE_TO_FILTER[lease.state];
  const canSelect = lease.state === LeaseState.LEASE_STATE_PENDING || lease.state === LeaseState.LEASE_STATE_ACTIVE;
  const isPending = lease.state === LeaseState.LEASE_STATE_PENDING;
  const isActive = lease.state === LeaseState.LEASE_STATE_ACTIVE;

  // Calculate cost per hour
  const costPerHour = (() => {
    let total = 0;
    for (const item of lease.items) {
      const perSecond = parseInt(item.locked_price.amount, 10);
      total += perSecond * parseInt(item.quantity, 10) * SECONDS_PER_HOUR;
    }
    const meta = lease.items[0]?.locked_price.denom
      ? DENOM_METADATA[lease.items[0].locked_price.denom] || { symbol: 'tokens', exponent: 6 }
      : { symbol: 'tokens', exponent: 6 };
    return `${(total / Math.pow(10, meta.exponent)).toFixed(4)} ${meta.symbol}/hr`;
  })();

  const handleGetConnectionInfo = async () => {
    // Toggle: if already showing, close it
    if (leaseInfo) {
      setLeaseInfo(null);
      return;
    }

    if (!tenantAddress || !provider?.api_url) {
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

      const info = await getLeaseConnectionInfo(provider.api_url, lease.uuid, authToken);
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
            <span className="lease-card-labeled-field">
              <span className="lease-card-label">Lease</span>
              <code className="lease-card-mono">{lease.uuid}</code>
              <button
                onClick={(e) => { e.stopPropagation(); copyToClipboard(lease.uuid); }}
                className="lease-card-copy-btn"
                title="Copy Lease UUID"
              >
                {copied ? <Check size={10} /> : <Copy size={10} />}
              </button>
            </span>

            <span className="lease-card-labeled-field">
              <span className="lease-card-label">Provider</span>
              <code className="lease-card-mono">{provider?.address || lease.provider_uuid}</code>
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

          {/* Metrics group */}
          <div className="lease-card-metrics">
            <span className="lease-card-cost">{costPerHour}</span>
            <span className="lease-card-time">
              <Clock size={11} />
              {formatRelativeTime(lease.created_at)}
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
                disabled={connectionLoading || !provider?.api_url}
                className="btn btn-primary btn-sm"
                title={!provider?.api_url ? 'Provider has no API URL' : undefined}
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

      {/* Lease Info Panel (inline) */}
      {leaseInfo && (
        <div className="lease-info-panel">
          <div className="lease-info-header">
            <span className="lease-info-title">
              <Wifi size={12} />
              Lease Info
            </span>
            <button
              onClick={() => setLeaseInfo(null)}
              className="lease-info-close"
              title="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
          <div className="lease-info-content">
            <JsonRenderer data={leaseInfo} copyToClipboard={copyToClipboard} />
          </div>
        </div>
      )}

      {/* === EXPANDED VIEW === */}
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
                <span className="lease-card-kv-label">Provider UUID</span>
                <code className="lease-card-kv-value">{lease.provider_uuid}</code>
                <button onClick={() => copyToClipboard(lease.provider_uuid)} className="lease-card-copy-btn" title="Copy">
                  <Copy size={10} />
                </button>
              </div>
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
                {lease.items.map((item) => {
                  const sku = getSKU(item.sku_uuid);
                  const pricePerHour =
                    (parseInt(item.locked_price.amount, 10) * SECONDS_PER_HOUR) /
                    Math.pow(10, DENOM_METADATA[item.locked_price.denom]?.exponent || 6);
                  const symbol = DENOM_METADATA[item.locked_price.denom]?.symbol || item.locked_price.denom;
                  return (
                    <tr key={`${lease.uuid}-item-${item.sku_uuid}`}>
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
   CREATE LEASE MODAL
   ============================================ */
function CreateLeaseModal({
  providers,
  skus,
  onClose,
  onSubmit,
  loading,
}: {
  providers: Provider[];
  skus: SKU[];
  onClose: () => void;
  onSubmit: (
    items: { skuUuid: string; quantity: number }[],
    payload?: Uint8Array,
    metaHash?: Uint8Array,
    providerUuid?: string
  ) => void;
  loading: boolean;
}) {
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const { items, addItem, removeItem, updateItem, resetItems, getItemsForSubmit } = useLeaseItems();
  const [payloadText, setPayloadText] = useState('');
  const [payloadHash, setPayloadHash] = useState<string | null>(null);
  const [payloadError, setPayloadError] = useState<string | null>(null);

  const payloadHashBytesRef = useRef<Uint8Array | null>(null);
  const hashedPayloadTextRef = useRef<string | null>(null);

  const providerSKUs = selectedProvider
    ? skus.filter((s) => s.provider_uuid === selectedProvider)
    : [];

  useEffect(() => {
    const computeHash = async () => {
      if (!payloadText) {
        setPayloadHash(null);
        setPayloadError(null);
        payloadHashBytesRef.current = null;
        hashedPayloadTextRef.current = null;
        return;
      }

      if (!validatePayloadSize(payloadText)) {
        setPayloadHash(null);
        setPayloadError(`Payload exceeds maximum size of ${MAX_PAYLOAD_SIZE / 1024}KB`);
        payloadHashBytesRef.current = null;
        hashedPayloadTextRef.current = null;
        return;
      }

      try {
        const hash = await sha256(payloadText);
        setPayloadHash(toHex(hash));
        payloadHashBytesRef.current = hash;
        hashedPayloadTextRef.current = payloadText;
        setPayloadError(null);
      } catch {
        setPayloadHash(null);
        setPayloadError('Failed to compute hash');
        payloadHashBytesRef.current = null;
        hashedPayloadTextRef.current = null;
      }
    };

    computeHash();
  }, [payloadText]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validation = validateFile(file);
    if (!validation.valid) {
      setPayloadError(validation.error || 'Invalid file');
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      if (typeof result === 'string') {
        setPayloadText(result);
      } else {
        setPayloadError('Failed to read file as text');
      }
    };
    reader.onerror = () => {
      setPayloadError('Failed to read file');
    };
    reader.readAsText(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validItems = getItemsForSubmit().filter(isValidLeaseItem);
    if (validItems.length > 0) {
      if (payloadText && payloadHash && payloadHashBytesRef.current) {
        if (hashedPayloadTextRef.current !== payloadText) {
          const hash = await sha256(payloadText);
          payloadHashBytesRef.current = hash;
          hashedPayloadTextRef.current = payloadText;
        }

        const payloadBytes = new TextEncoder().encode(hashedPayloadTextRef.current!);
        onSubmit(validItems, payloadBytes, payloadHashBytesRef.current, selectedProvider);
      } else {
        onSubmit(validItems);
      }
    }
  };

  const estimatedCost = calculateEstimatedCost(items, skus);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="card-static w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between p-4 border-b border-surface-700 bg-surface-900/95 backdrop-blur">
          <h3 className="text-lg font-heading font-semibold">Create Lease</h3>
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
          {/* Provider Selection */}
          <div>
            <label className="mb-1 block text-sm text-muted">Provider</label>
            <select
              value={selectedProvider}
              onChange={(e) => {
                setSelectedProvider(e.target.value);
                resetItems();
              }}
              className="input select w-full"
              required
              disabled={loading}
            >
              <option value="">Select a provider...</option>
              {providers.map((p) => (
                <option key={p.uuid} value={p.uuid}>
                  {truncateAddress(p.address)}
                </option>
              ))}
            </select>
          </div>

          {/* SKU Items */}
          {selectedProvider && (
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
              {providerSKUs.length === 0 ? (
                <p className="text-sm text-dim">No active SKUs for this provider</p>
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
                        {providerSKUs.map((sku) => (
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
                          updateItem(item.id, 'quantity', parseInt(e.target.value, 10) || 1)
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
          )}

          {/* Deployment Payload */}
          {selectedProvider && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className="text-sm text-muted">Deployment Payload (optional)</label>
                <label className="cursor-pointer text-sm text-primary-400 hover:text-primary-300">
                  <input
                    type="file"
                    onChange={handleFileUpload}
                    className="hidden"
                    accept=".yaml,.yml,.json,.txt"
                    disabled={loading}
                  />
                  Upload File
                </label>
              </div>
              <textarea
                value={payloadText}
                onChange={(e) => setPayloadText(e.target.value)}
                placeholder="Paste your deployment manifest here..."
                rows={4}
                className="input w-full font-mono text-sm"
                disabled={loading}
              />
              <div className="mt-1 flex items-center justify-between text-xs">
                <span className={payloadError ? 'text-error' : 'text-dim'}>
                  {payloadError || `${getPayloadSize(payloadText).toLocaleString()} / ${(MAX_PAYLOAD_SIZE / 1024).toFixed(0)}KB`}
                </span>
                {payloadHash && (
                  <span className="font-mono text-dim" title={payloadHash}>
                    SHA-256: {payloadHash.slice(0, 12)}...
                  </span>
                )}
              </div>
            </div>
          )}

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
              disabled={loading || !selectedProvider || items.some((i) => !i.skuUuid) || !!payloadError}
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
