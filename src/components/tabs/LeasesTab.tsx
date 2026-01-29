import { useState, useEffect, useCallback, useRef } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Link, Shield, Plus, ChevronDown, ChevronUp, Clock, Copy, Check, X, ExternalLink, Zap, CheckCircle, XCircle, Package, Calendar, Hash, Wifi } from 'lucide-react';
import { LeaseState, type Lease } from '../../api/billing';
import { SECONDS_PER_HOUR } from '../../config/constants';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { truncateAddress } from '../../utils/address';
import { formatDate, formatRelativeTime } from '../../utils/format';
import { LEASE_STATE_LABELS } from '../../utils/leaseState';
import { getLeasesByTenant, getBillingParams } from '../../api/billing';
import { getProviders, getSKUs, type Provider, type SKU } from '../../api/sku';
import { createLease, cancelLease, closeLease, type TxResult, type CreateLeaseResult } from '../../api/tx';
import { DENOM_METADATA, formatPrice, UNIT_LABELS } from '../../api/config';
import { Unit } from '../../api/sku';
import {
  createSignMessage,
  createAuthToken,
  createLeaseDataSignMessage,
  createLeaseDataAuthToken,
  getLeaseConnectionInfo,
  uploadLeaseData,
  type ConnectionInfo,
} from '../../api/provider-api';
import { sha256, toHex, validatePayloadSize, getPayloadSize, MAX_PAYLOAD_SIZE } from '../../utils/hash';
import { validateFile } from '../../utils/fileValidation';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';
import { AutoRefreshIndicator } from '../ui/AutoRefreshIndicator';
import { useToast } from '../../hooks/useToast';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonCard } from '../ui/SkeletonCard';
import { ErrorBanner } from '../ui/ErrorBanner';
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

type FilterState = 'all' | 'pending' | 'active' | 'closed' | 'rejected';

const LEASE_STATE_TO_FILTER: Record<LeaseState, FilterState> = {
  [LeaseState.LEASE_STATE_PENDING]: 'pending',
  [LeaseState.LEASE_STATE_ACTIVE]: 'active',
  [LeaseState.LEASE_STATE_CLOSED]: 'closed',
  [LeaseState.LEASE_STATE_REJECTED]: 'rejected',
  [LeaseState.LEASE_STATE_EXPIRED]: 'closed', // Group expired with closed
  [LeaseState.LEASE_STATE_UNSPECIFIED]: 'all',
  [LeaseState.UNRECOGNIZED]: 'all',
};

export function LeasesTab() {
  const { address, isWalletConnected, openView, getOfflineSigner, signArbitrary } = useChain(CHAIN_NAME);
  const toast = useToast();

  const [activeFilter, setActiveFilter] = useState<FilterState>('all');
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

  const autoRefresh = useAutoRefresh(fetchData, {
    interval: 5000,
    enabled: true,
    immediate: true,
  });

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

  const filteredLeases = activeFilter === 'all'
    ? leases
    : leases.filter((l) => LEASE_STATE_TO_FILTER[l.state] === activeFilter);

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

  // Count actionable (selectable) leases
  const actionableLeases = filteredLeases.filter(
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
    return <ErrorBanner error={error} onRetry={autoRefresh.refresh} />;
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
        <div className="flex items-center gap-2">
          <AutoRefreshIndicator autoRefresh={autoRefresh} intervalSeconds={5} />
          <button
            onClick={() => setShowCreateLease(true)}
            disabled={providers.length === 0}
            className="btn btn-primary btn-sm"
          >
            <Plus size={14} />
            New Lease
          </button>
        </div>
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
          filteredLeases.map((lease) => (
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
  activeFilter: FilterState;
  onChange: (filter: FilterState) => void;
  counts: Record<FilterState, number>;
}) {
  const filters: { key: FilterState; label: string }[] = [
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
   LEASE CARD COMPONENT
   ============================================ */

// State icons for visual recognition
const STATE_ICONS: Record<FilterState, React.ReactNode> = {
  all: null,
  pending: <Clock size={12} />,
  active: <Zap size={12} />,
  closed: <CheckCircle size={12} />,
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
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [closeReason, setCloseReason] = useState('');

  const provider = getProvider(lease.provider_uuid);
  const stateKey = LEASE_STATE_TO_FILTER[lease.state];
  const canSelect = lease.state === LeaseState.LEASE_STATE_PENDING || lease.state === LeaseState.LEASE_STATE_ACTIVE;

  // Calculate summary
  const itemCount = lease.items.reduce((sum, item) => sum + parseInt(item.quantity, 10), 0);
  const totalPerHour = (() => {
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
      setConnectionInfo(info);
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : 'Failed to get connection info');
    } finally {
      setConnectionLoading(false);
    }
  };

  const connectionUrl = connectionInfo
    ? `${connectionInfo.connection.protocol}://${connectionInfo.connection.host}:${connectionInfo.connection.port}`
    : null;

  return (
    <div
      className={`lease-card ${isSelected ? 'selected' : ''}`}
      data-state={stateKey}
    >
      {/* Main row - single horizontal line */}
      <div className="lease-card-body">
        {canSelect && onToggleSelect && (
          <input
            type="checkbox"
            checked={isSelected || false}
            onChange={onToggleSelect}
            className="lease-card-checkbox"
          />
        )}

        <div className="lease-card-info">
          {/* State badge */}
          <span className="lease-card-state" data-state={stateKey}>
            <span className="lease-card-state-icon">{STATE_ICONS[stateKey]}</span>
            {LEASE_STATE_LABELS[lease.state]}
          </span>

          {/* Provider */}
          <span className="lease-card-provider">
            <span className="lease-card-provider-name">
              {provider ? truncateAddress(provider.address) : lease.provider_uuid.slice(0, 8)}
            </span>
          </span>

          {/* Metrics inline */}
          <div className="lease-card-metrics">
            <span className="lease-card-metric">
              <Package size={11} className="lease-card-metric-icon" />
              {itemCount}
            </span>
            <span className="lease-card-metric">
              <span className="lease-card-cost">{totalPerHour}</span>
            </span>
            <span className="lease-card-metric">
              <Clock size={11} className="lease-card-metric-icon" />
              {formatRelativeTime(lease.created_at)}
            </span>
          </div>

          {/* UUID on hover */}
          <div className="lease-card-uuid">
            <span>{lease.uuid.slice(0, 8)}…{lease.uuid.slice(-4)}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                copyToClipboard(lease.uuid);
              }}
              className="lease-card-uuid-btn"
              title="Copy UUID"
            >
              {copied ? <Check size={10} /> : <Copy size={10} />}
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="lease-card-actions">
          {lease.state === LeaseState.LEASE_STATE_PENDING && (
            <button
              onClick={() => onCancel(lease.uuid)}
              disabled={txLoading}
              className="btn btn-danger btn-sm"
            >
              Cancel
            </button>
          )}
          {lease.state === LeaseState.LEASE_STATE_ACTIVE && (
            <>
              <button
                onClick={handleGetConnectionInfo}
                disabled={connectionLoading || !provider?.api_url}
                className="btn btn-primary btn-sm"
                title={!provider?.api_url ? 'Provider has no API URL' : undefined}
              >
                {connectionLoading ? '...' : 'Connect'}
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
          <span className="lease-card-actions-divider" />
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className={`lease-card-expand ${isExpanded ? 'expanded' : ''}`}
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Connection panel - inline */}
      {connectionInfo && connectionUrl && (
        <div className="connection-panel">
          <span className="connection-panel-label">
            <Wifi size={10} className="connection-panel-label-icon" />
            Live
          </span>
          <span className="connection-panel-url">{connectionUrl}</span>
          <div className="connection-panel-actions">
            <button
              onClick={() => copyToClipboard(connectionUrl)}
              className={`connection-panel-btn ${copied ? 'success' : ''}`}
              title="Copy"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
            <a
              href={connectionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="connection-panel-btn"
              title="Open"
            >
              <ExternalLink size={12} />
            </a>
            <button
              onClick={() => setConnectionInfo(null)}
              className="connection-panel-btn"
              title="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Connection error */}
      {connectionError && (
        <div className="inline-form" style={{ background: 'oklch(0.55 0.15 25 / 0.1)', borderColor: 'oklch(0.55 0.15 25 / 0.3)' }}>
          <span className="text-error text-xs flex-1">{connectionError}</span>
          <button onClick={() => setConnectionError(null)} className="btn btn-ghost btn-sm">
            <X size={12} />
          </button>
        </div>
      )}

      {/* Close form */}
      {showCloseForm && (
        <div className="inline-form">
          <input
            type="text"
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
            placeholder="Reason (optional)"
            maxLength={256}
            className="input"
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
            onClick={() => {
              setShowCloseForm(false);
              setCloseReason('');
            }}
            className="btn btn-ghost btn-sm"
          >
            ×
          </button>
        </div>
      )}

      {/* Expandable Details - horizontal grid */}
      {isExpanded && (
        <div className="lease-card-details">
          <div className="lease-card-details-grid">
            {/* Lease Info */}
            <div className="lease-card-detail-group">
              <div className="lease-card-detail-group-title">
                <Hash size={10} className="lease-card-detail-group-icon" />
                Lease
              </div>
              <div className="lease-card-detail-row">
                <span className="lease-card-detail-label">UUID</span>
                <span className="lease-card-detail-value mono">{lease.uuid.slice(0, 12)}…</span>
              </div>
              {lease.meta_hash && (
                <div className="lease-card-detail-row">
                  <span className="lease-card-detail-label">Hash</span>
                  <span className="lease-card-detail-value mono">{lease.meta_hash.slice(0, 12)}…</span>
                </div>
              )}
            </div>

            {/* Items */}
            <div className="lease-card-detail-group">
              <div className="lease-card-detail-group-title">
                <Package size={10} className="lease-card-detail-group-icon" />
                Items
              </div>
              <div className="lease-card-items">
                {lease.items.map((item) => {
                  const sku = getSKU(item.sku_uuid);
                  const pricePerHour =
                    (parseInt(item.locked_price.amount, 10) * SECONDS_PER_HOUR) /
                    Math.pow(10, DENOM_METADATA[item.locked_price.denom]?.exponent || 6);
                  const symbol = DENOM_METADATA[item.locked_price.denom]?.symbol || item.locked_price.denom;

                  return (
                    <div key={`${lease.uuid}-item-${item.sku_uuid}`} className="lease-card-item">
                      <span className="lease-card-item-name">
                        {sku?.name || item.sku_uuid.slice(0, 8)} ×{item.quantity}
                      </span>
                      <span className="lease-card-item-price">
                        {pricePerHour.toFixed(4)} {symbol}/hr
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Timeline */}
            <div className="lease-card-detail-group">
              <div className="lease-card-detail-group-title">
                <Calendar size={10} className="lease-card-detail-group-icon" />
                Timeline
              </div>
              <div className="lease-card-timeline">
                <div className="lease-card-timeline-item active">
                  <span className="lease-card-timeline-label">Created</span>
                  <span className="lease-card-timeline-date">{formatDate(lease.created_at, 'date')}</span>
                </div>
                {lease.acknowledged_at && (
                  <div className="lease-card-timeline-item success">
                    <span className="lease-card-timeline-label">Ack</span>
                    <span className="lease-card-timeline-date">{formatDate(lease.acknowledged_at, 'date')}</span>
                  </div>
                )}
                {lease.closed_at && (
                  <div className="lease-card-timeline-item">
                    <span className="lease-card-timeline-label">Closed</span>
                    <span className="lease-card-timeline-date">{formatDate(lease.closed_at, 'date')}</span>
                    {lease.closure_reason && <span className="lease-card-timeline-reason">— {lease.closure_reason}</span>}
                  </div>
                )}
                {lease.rejected_at && (
                  <div className="lease-card-timeline-item error">
                    <span className="lease-card-timeline-label">Rejected</span>
                    <span className="lease-card-timeline-date">{formatDate(lease.rejected_at, 'date')}</span>
                    {lease.rejection_reason && <span className="lease-card-timeline-reason">— {lease.rejection_reason}</span>}
                  </div>
                )}
              </div>
            </div>

            {/* Connection (if active) */}
            {connectionInfo && (
              <div className="lease-card-detail-group">
                <div className="lease-card-detail-group-title">
                  <Wifi size={10} className="lease-card-detail-group-icon" />
                  Connection
                </div>
                <div className="lease-card-detail-row">
                  <span className="lease-card-detail-label">Host</span>
                  <span className="lease-card-detail-value highlight">{connectionInfo.connection.host}</span>
                </div>
                <div className="lease-card-detail-row">
                  <span className="lease-card-detail-label">Port</span>
                  <span className="lease-card-detail-value">{connectionInfo.connection.port}</span>
                </div>
              </div>
            )}
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
  const [items, setItems] = useState<{ skuUuid: string; quantity: number }[]>([
    { skuUuid: '', quantity: 1 },
  ]);
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

  const addItem = () => setItems([...items, { skuUuid: '', quantity: 1 }]);
  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));
  const updateItem = (idx: number, field: 'skuUuid' | 'quantity', value: string | number) => {
    setItems(items.map((item, i) => (i === idx ? { ...item, [field]: value } : item)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validItems = items.filter((item) => item.skuUuid && item.quantity > 0);
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

  const calculateEstimatedCost = () => {
    let total = 0;
    let denom = '';
    let unit: Unit = Unit.UNIT_UNSPECIFIED;

    for (const item of items) {
      if (item.skuUuid) {
        const sku = skus.find((s) => s.uuid === item.skuUuid);
        if (sku) {
          denom = sku.base_price.denom;
          unit = sku.unit;
          const price = parseInt(sku.base_price.amount, 10);
          total += price * item.quantity;
        }
      }
    }

    if (total === 0) return null;

    const meta = DENOM_METADATA[denom] || { symbol: denom, exponent: 6 };
    const value = total / Math.pow(10, meta.exponent);
    const unitLabel = UNIT_LABELS[unit] ?? '';
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${meta.symbol}${unitLabel}`;
  };

  const estimatedCost = calculateEstimatedCost();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="card-static w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between p-4 border-b border-surface-700 bg-surface-900/95 backdrop-blur">
          <h3 className="text-lg font-heading font-semibold">Create Lease</h3>
          <button onClick={onClose} className="text-muted hover:text-primary p-1" disabled={loading}>
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
                setItems([{ skuUuid: '', quantity: 1 }]);
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
                  {items.map((item, idx) => (
                    <div key={`create-item-${idx}`} className="flex gap-2">
                      <select
                        value={item.skuUuid}
                        onChange={(e) => updateItem(idx, 'skuUuid', e.target.value)}
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
                          updateItem(idx, 'quantity', parseInt(e.target.value, 10) || 1)
                        }
                        className="input w-20"
                        disabled={loading}
                      />
                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
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
