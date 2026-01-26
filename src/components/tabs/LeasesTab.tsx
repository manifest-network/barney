import { useState, useEffect, useCallback } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Link, Shield, Plus } from 'lucide-react';
import type { Lease, LeaseState } from '../../api/billing';
import { getLeasesByTenant, getBillingParams } from '../../api/billing';
import { getProviders, getSKUs, type Provider, type SKU } from '../../api/sku';
import { createLease, cancelLease, closeLease, type TxResult } from '../../api/tx';
import { DENOM_METADATA, formatPrice } from '../../api/config';
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
import { safeJsonStringify } from '../../utils/url';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';
import { AutoRefreshIndicator } from '../AutoRefreshIndicator';
import { useToast } from '../../hooks/useToast';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonStatGrid } from '../ui/SkeletonStat';
import { SkeletonCard } from '../ui/SkeletonCard';

// Allowed MIME types for file uploads
const ALLOWED_FILE_TYPES = [
  'text/plain',
  'text/yaml',
  'text/x-yaml',
  'application/x-yaml',
  'application/json',
  'application/octet-stream', // Allow for files without recognized MIME type
];

// Maximum file name length to prevent path traversal
const MAX_FILENAME_LENGTH = 255;

/**
 * Validates a file before upload
 */
function validateFile(file: File): { valid: boolean; error?: string } {
  // Check file size
  if (file.size > MAX_PAYLOAD_SIZE) {
    return { valid: false, error: `File exceeds maximum size of ${MAX_PAYLOAD_SIZE / 1024}KB` };
  }

  // Check filename length
  if (file.name.length > MAX_FILENAME_LENGTH) {
    return { valid: false, error: 'Filename is too long' };
  }

  // Check MIME type (with fallback for unrecognized types)
  if (file.type && !ALLOWED_FILE_TYPES.includes(file.type)) {
    return { valid: false, error: `File type "${file.type}" is not allowed. Use .yaml, .yml, .json, or .txt files.` };
  }

  return { valid: true };
}

/**
 * Validates a signature message before signing
 * Ensures the message follows expected format and contains only safe characters
 */
function validateSignMessage(message: string, expectedPrefix: string): boolean {
  if (!message || typeof message !== 'string') return false;
  if (!message.startsWith(expectedPrefix)) return false;
  // Only allow alphanumeric, spaces, colons, and hyphens in the message
  const safePattern = /^[a-zA-Z0-9\s:\-]+$/;
  return safePattern.test(message);
}

const CHAIN_NAME = 'manifestlocal';

const stateBadgeClasses: Record<LeaseState, string> = {
  LEASE_STATE_UNSPECIFIED: 'badge badge-neutral',
  LEASE_STATE_PENDING: 'badge badge-warning',
  LEASE_STATE_ACTIVE: 'badge badge-success',
  LEASE_STATE_CLOSED: 'badge badge-neutral',
  LEASE_STATE_REJECTED: 'badge badge-error',
  LEASE_STATE_EXPIRED: 'badge badge-neutral',
};

const stateLabels: Record<LeaseState, string> = {
  LEASE_STATE_UNSPECIFIED: 'Unspecified',
  LEASE_STATE_PENDING: 'Pending',
  LEASE_STATE_ACTIVE: 'Active',
  LEASE_STATE_CLOSED: 'Closed',
  LEASE_STATE_REJECTED: 'Rejected',
  LEASE_STATE_EXPIRED: 'Expired',
};

function formatAddress(addr: string): string {
  if (!addr || addr.length < 20) return addr;
  const prefix = addr.slice(0, 9); // manifest1
  const start = addr.slice(9, 13);
  const end = addr.slice(-4);
  return `${prefix}${start}...${end}`;
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
}

export function LeasesTab() {
  const { address, isWalletConnected, openView, getOfflineSigner, signArbitrary } = useChain(CHAIN_NAME);
  const toast = useToast();

  const [stateFilter, setStateFilter] = useState<LeaseState | 'all'>('all');
  const [showCreateLease, setShowCreateLease] = useState(false);
  const [leases, setLeases] = useState<Lease[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [skus, setSKUs] = useState<SKU[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInAllowedList, setIsInAllowedList] = useState(false);
  const [txLoading, setTxLoading] = useState(false);
  const [selectedLeases, setSelectedLeases] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    if (!address) {
      setLeases([]);
      setLoading(false);
      return;
    }

    try {
      if (leases.length === 0) {
        setLoading(true);
      }
      setError(null);

      const [leasesData, providersData, skusData, billingParams] = await Promise.all([
        getLeasesByTenant(address),
        getProviders(true), // active only
        getSKUs(true), // active only
        getBillingParams(),
      ]);

      setLeases(leasesData);
      setProviders(providersData);
      setSKUs(skusData);
      setIsInAllowedList(billingParams.allowed_list.includes(address));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [address, leases.length]);

  const autoRefresh = useAutoRefresh(fetchData, {
    interval: 5000, // 5 seconds
    enabled: true,
    immediate: true,
  });

  const getSKU = (uuid: string) => skus.find((s) => s.uuid === uuid);
  const getProvider = (uuid: string) => providers.find((p) => p.uuid === uuid);

  const filteredLeases =
    stateFilter === 'all' ? leases : leases.filter((l) => l.state === stateFilter);

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

      const result: TxResult = await createLease(signer, address, items, metaHash);

      if (result.success) {
        // If we have payload, we need to upload it to the provider
        if (payload && metaHash && providerUuid) {
          toast.info('Uploading payload to provider...');

          // Find the provider to get their API URL
          const provider = providers.find((p) => p.uuid === providerUuid);
          if (!provider?.api_url) {
            toast.warning(`Lease created but provider has no API URL. Tx: ${result.transactionHash?.slice(0, 16)}...`);
            setShowCreateLease(false);
            await fetchData();
            return;
          }

          // Refresh leases to find the newly created one
          const updatedLeases = await getLeasesByTenant(address);
          const metaHashHex = toHex(metaHash);

          // Find the new pending lease with matching meta_hash
          const newLease = updatedLeases.find(
            (l) => l.state === 'LEASE_STATE_PENDING' && l.meta_hash === metaHashHex
          );

          if (!newLease) {
            toast.warning(`Lease created but couldn't find it to upload payload. Tx: ${result.transactionHash?.slice(0, 16)}...`);
            setShowCreateLease(false);
            await fetchData();
            return;
          }

          try {
            // Create auth token for payload upload
            const timestamp = Math.floor(Date.now() / 1000);
            const signMessage = createLeaseDataSignMessage(newLease.uuid, metaHashHex, timestamp);

            // Validate message format before signing
            if (!validateSignMessage(signMessage, 'manifest lease data')) {
              throw new Error('Invalid signature message format');
            }

            const signResult = await signArbitrary(address, signMessage);

            const authToken = createLeaseDataAuthToken(
              address,
              newLease.uuid,
              metaHashHex,
              timestamp,
              signResult.pub_key.value,
              signResult.signature
            );

            await uploadLeaseData(provider.api_url, newLease.uuid, payload, authToken);
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
      return lease?.state === 'LEASE_STATE_PENDING';
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
        setSelectedLeases(new Set());
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

  const handleBatchClose = async (reason?: string) => {
    if (!address || selectedLeases.size === 0) return;

    const activeSelected = Array.from(selectedLeases).filter((uuid) => {
      const lease = leases.find((l) => l.uuid === uuid);
      return lease?.state === 'LEASE_STATE_ACTIVE';
    });

    if (activeSelected.length === 0) {
      toast.warning('No active leases selected');
      return;
    }

    try {
      const signer = getOfflineSigner();
      setTxLoading(true);

      const result: TxResult = await closeLease(signer, address, activeSelected, reason);

      if (result.success) {
        toast.success(`${activeSelected.length} lease(s) closed! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        setSelectedLeases(new Set());
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

  const toggleLeaseSelection = (uuid: string) => {
    setSelectedLeases((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  };

  const selectAllFiltered = () => {
    const actionableLeases = filteredLeases.filter(
      (l) => l.state === 'LEASE_STATE_PENDING' || l.state === 'LEASE_STATE_ACTIVE'
    );
    setSelectedLeases(new Set(actionableLeases.map((l) => l.uuid)));
  };

  const deselectAll = () => {
    setSelectedLeases(new Set());
  };

  // Count selected by state
  const selectedPendingCount = Array.from(selectedLeases).filter((uuid) => {
    const lease = leases.find((l) => l.uuid === uuid);
    return lease?.state === 'LEASE_STATE_PENDING';
  }).length;

  const selectedActiveCount = Array.from(selectedLeases).filter((uuid) => {
    const lease = leases.find((l) => l.uuid === uuid);
    return lease?.state === 'LEASE_STATE_ACTIVE';
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
      <div className="space-y-6">
        <SkeletonStatGrid count={4} />
        <SkeletonCard />
        <SkeletonCard />
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

  return (
    <div className="space-y-6">
      {/* Billing Module Status */}
      {isInAllowedList && (
        <div className="card-static p-4 border-primary-500/50 bg-primary-500/10">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-primary-400" />
            <span className="font-medium text-primary-300">Billing Module Admin</span>
          </div>
          <p className="mt-1 text-sm text-primary-400/80">
            Your wallet is in the billing module allowed list.
          </p>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">Filter:</span>
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value as LeaseState | 'all')}
              className="input select text-sm py-1.5"
            >
              <option value="all">All States</option>
              <option value="LEASE_STATE_PENDING">Pending</option>
              <option value="LEASE_STATE_ACTIVE">Active</option>
              <option value="LEASE_STATE_CLOSED">Closed</option>
              <option value="LEASE_STATE_REJECTED">Rejected</option>
              <option value="LEASE_STATE_EXPIRED">Expired</option>
            </select>
          </div>
          <AutoRefreshIndicator autoRefresh={autoRefresh} intervalSeconds={5} />
        </div>
        <button
          onClick={() => setShowCreateLease(true)}
          disabled={providers.length === 0}
          className="btn btn-primary"
        >
          <Plus size={16} />
          Create Lease
        </button>
      </div>

      {/* Batch Selection Controls */}
      {filteredLeases.some((l) => l.state === 'LEASE_STATE_PENDING' || l.state === 'LEASE_STATE_ACTIVE') && (
        <div className="flex flex-wrap items-center gap-4 card-static p-3">
          <div className="flex items-center gap-2">
            <button
              onClick={selectAllFiltered}
              className="text-sm text-primary-400 hover:text-primary-300"
            >
              Select All
            </button>
            <span className="text-surface-600">|</span>
            <button
              onClick={deselectAll}
              className="text-sm text-muted hover:text-primary"
            >
              Deselect All
            </button>
            {selectedLeases.size > 0 && (
              <span className="ml-2 text-sm text-muted">
                ({selectedLeases.size} selected)
              </span>
            )}
          </div>
          {selectedLeases.size > 0 && (
            <div className="flex items-center gap-2">
              {selectedPendingCount > 0 && (
                <button
                  onClick={handleBatchCancel}
                  disabled={txLoading}
                  className="btn btn-danger btn-sm"
                >
                  Cancel {selectedPendingCount} Pending
                </button>
              )}
              {selectedActiveCount > 0 && (
                <button
                  onClick={() => handleBatchClose()}
                  disabled={txLoading}
                  className="btn btn-secondary btn-sm"
                >
                  Close {selectedActiveCount} Active
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-4">
        {(
          [
            'LEASE_STATE_PENDING',
            'LEASE_STATE_ACTIVE',
            'LEASE_STATE_CLOSED',
            'LEASE_STATE_REJECTED',
          ] as LeaseState[]
        ).map((state) => {
          const count = leases.filter((l) => l.state === state).length;
          const colorClass = state === 'LEASE_STATE_PENDING' ? 'text-warning'
            : state === 'LEASE_STATE_ACTIVE' ? 'text-success'
            : state === 'LEASE_STATE_REJECTED' ? 'text-error'
            : 'text-muted';
          return (
            <div key={state} className="stat-card">
              <div className={`stat-value ${colorClass}`}>{count}</div>
              <div className="stat-label">{stateLabels[state]}</div>
            </div>
          );
        })}
      </div>

      {/* Leases List */}
      <div className="space-y-4">
        {filteredLeases.length === 0 ? (
          <div className="card-static p-8 text-center">
            <p className="text-muted">No leases found</p>
            {providers.length > 0 ? (
              <button
                onClick={() => setShowCreateLease(true)}
                className="mt-4 text-primary-400 hover:text-primary-300"
              >
                Create your first lease
              </button>
            ) : (
              <p className="mt-2 text-sm text-dim">No active providers available</p>
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
              txLoading={txLoading || false}
              tenantAddress={address}
              isSelected={selectedLeases.has(lease.uuid)}
              onToggleSelect={() => toggleLeaseSelection(lease.uuid)}
            />
          ))
        )}
      </div>

      {/* Create Lease Modal */}
      {showCreateLease && (
        <CreateLeaseModal
          providers={providers}
          skus={skus}
          onClose={() => setShowCreateLease(false)}
          onSubmit={handleCreateLease}
          loading={txLoading || false}
        />
      )}
    </div>
  );
}

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

  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [closeReason, setCloseReason] = useState('');

  const provider = getProvider(lease.provider_uuid);
  const badgeClass = stateBadgeClasses[lease.state];

  const formatDate = (dateStr?: string) => {
    if (!dateStr || dateStr === '0001-01-01T00:00:00Z') return '-';
    return new Date(dateStr).toLocaleString();
  };

  const calculateTotalPerHour = () => {
    let total = 0;
    for (const item of lease.items) {
      const perSecond = parseInt(item.locked_price.amount, 10);
      total += perSecond * parseInt(item.quantity, 10) * 3600;
    }
    const meta = lease.items[0]?.locked_price.denom
      ? DENOM_METADATA[lease.items[0].locked_price.denom] || { symbol: 'tokens', exponent: 6 }
      : { symbol: 'tokens', exponent: 6 };
    return `${(total / Math.pow(10, meta.exponent)).toFixed(4)} ${meta.symbol}/hr`;
  };

  const handleGetConnectionInfo = async () => {
    if (!tenantAddress || !provider?.api_url) {
      setConnectionError('Missing tenant address or provider API URL');
      return;
    }

    try {
      setConnectionLoading(true);
      setConnectionError(null);

      // Create the message to sign
      const timestamp = Math.floor(Date.now() / 1000);
      const message = createSignMessage(tenantAddress, lease.uuid, timestamp);

      // Validate message format before signing
      if (!validateSignMessage(message, tenantAddress)) {
        throw new Error('Invalid signature message format');
      }

      // Sign the message using ADR-036
      const signResult = await signArbitrary(tenantAddress, message);

      // Create the auth token
      const authToken = createAuthToken(
        tenantAddress,
        lease.uuid,
        timestamp,
        signResult.pub_key.value,
        signResult.signature
      );

      // Fetch connection info from provider API
      const info = await getLeaseConnectionInfo(provider.api_url, lease.uuid, authToken);
      setConnectionInfo(info);
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : 'Failed to get connection info');
    } finally {
      setConnectionLoading(false);
    }
  };

  const canSelect = lease.state === 'LEASE_STATE_PENDING' || lease.state === 'LEASE_STATE_ACTIVE';

  return (
    <div className={`card-static p-6 ${isSelected ? 'border-primary-500' : ''}`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {canSelect && onToggleSelect && (
            <input
              type="checkbox"
              checked={isSelected || false}
              onChange={onToggleSelect}
              className="mt-1 h-4 w-4 rounded border-surface-600 bg-surface-700 text-primary-600 focus:ring-primary-500 focus:ring-offset-surface-800"
            />
          )}
          <div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm text-muted">{lease.uuid}</span>
            <button
              onClick={() => copyToClipboard(lease.uuid)}
              className="text-xs text-primary-400 hover:text-primary-300"
            >
              Copy
            </button>
            <span className={badgeClass}>
              {stateLabels[lease.state]}
            </span>
          </div>
          <div className="mt-1 text-sm text-dim">
            Provider: {provider ? formatAddress(provider.address) : lease.provider_uuid}
          </div>
        </div>
        </div>
        <div className="flex gap-2">
          {lease.state === 'LEASE_STATE_PENDING' && (
            <button
              onClick={() => onCancel(lease.uuid)}
              disabled={txLoading}
              className="btn btn-danger btn-sm"
            >
              Cancel
            </button>
          )}
          {lease.state === 'LEASE_STATE_ACTIVE' && (
            <>
              <button
                onClick={handleGetConnectionInfo}
                disabled={connectionLoading || !provider?.api_url}
                className="btn btn-primary btn-sm"
                title={!provider?.api_url ? 'Provider has no API URL configured' : undefined}
              >
                {connectionLoading ? 'Loading...' : 'Get Connection'}
              </button>
              <button
                onClick={() => setShowCloseForm(!showCloseForm)}
                disabled={txLoading}
                className="btn btn-secondary btn-sm"
              >
                Close
              </button>
            </>
          )}
        </div>
      </div>

      {/* Connection Info */}
      {connectionError && (
        <div className="mb-4 rounded-lg border border-error-500/30 bg-error-500/10 p-3 text-sm text-error">
          {connectionError}
          <button
            onClick={() => setConnectionError(null)}
            className="ml-2 text-muted hover:text-primary"
          >
            ✕
          </button>
        </div>
      )}

      {connectionInfo && (
        <div className="mb-4 rounded-lg border border-primary-500/30 bg-primary-500/10 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase text-primary-400">Connection Info</span>
            <button
              onClick={() => setConnectionInfo(null)}
              className="text-muted hover:text-primary"
            >
              ✕
            </button>
          </div>
          <div className="space-y-1 text-sm">
            <div>
              <span className="text-muted">Host: </span>
              <span className="font-mono text-primary">{connectionInfo.connection.host}</span>
            </div>
            <div>
              <span className="text-muted">Port: </span>
              <span className="font-mono text-primary">{connectionInfo.connection.port}</span>
            </div>
            <div>
              <span className="text-muted">Protocol: </span>
              <span className="font-mono text-primary">{connectionInfo.connection.protocol}</span>
            </div>
            {connectionInfo.connection.metadata && (
              <div>
                <span className="text-muted">Metadata: </span>
                <span className="font-mono text-primary">
                  {safeJsonStringify(connectionInfo.connection.metadata)}
                </span>
              </div>
            )}
            <div className="mt-2">
              <button
                onClick={() => {
                  const url = `${connectionInfo.connection.protocol}://${connectionInfo.connection.host}:${connectionInfo.connection.port}`;
                  copyToClipboard(url);
                }}
                className="text-xs text-primary-400 hover:text-primary-300"
              >
                Copy URL
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Close Form */}
      {showCloseForm && (
        <div className="mb-4 rounded-lg border border-warning-500/30 bg-warning-500/10 p-3">
          <label className="mb-1 block text-sm text-muted">Closure Reason (optional)</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              placeholder="e.g., No longer needed"
              maxLength={256}
              className="input flex-1 text-sm"
              disabled={txLoading}
            />
            <button
              onClick={() => {
                onClose(lease.uuid, closeReason || undefined);
                setShowCloseForm(false);
                setCloseReason('');
              }}
              disabled={txLoading}
              className="btn btn-secondary btn-sm"
            >
              Confirm Close
            </button>
            <button
              onClick={() => {
                setShowCloseForm(false);
                setCloseReason('');
              }}
              disabled={txLoading}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Lease Items */}
      <div className="mb-4 rounded-lg bg-surface-800/50 p-3">
        <div className="mb-2 text-xs font-medium uppercase text-dim">Items</div>
        <div className="space-y-2">
          {lease.items.map((item, idx) => {
            const sku = getSKU(item.sku_uuid);
            const pricePerHour =
              (parseInt(item.locked_price.amount, 10) * 3600) /
              Math.pow(10, DENOM_METADATA[item.locked_price.denom]?.exponent || 6);
            const symbol = DENOM_METADATA[item.locked_price.denom]?.symbol || item.locked_price.denom;

            return (
              <div key={idx} className="flex items-center justify-between text-sm">
                <span className="text-primary">
                  {sku?.name || item.sku_uuid} × {item.quantity}
                </span>
                <span className="text-muted">
                  {pricePerHour.toFixed(4)} {symbol}/hr each
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-3 border-t border-surface-600 pt-2 text-right">
          <span className="text-sm text-muted">Total: </span>
          <span className="font-medium text-success">{calculateTotalPerHour()}</span>
        </div>
      </div>

      {/* Meta Hash (Payload Reference) */}
      {lease.meta_hash && (
        <div className="mb-4 rounded-lg bg-surface-800/50 p-3">
          <div className="mb-1 text-xs font-medium uppercase text-dim">Payload Hash</div>
          <div className="flex items-center gap-2">
            <span className="break-all font-mono text-xs text-muted">{lease.meta_hash}</span>
            <button
              type="button"
              onClick={() => lease.meta_hash && copyToClipboard(lease.meta_hash)}
              className="shrink-0 text-xs text-primary-400 hover:text-primary-300"
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {/* Timestamps */}
      <div className="grid gap-2 text-xs text-dim sm:grid-cols-2">
        <div>Created: {formatDate(lease.created_at)}</div>
        <div>Last Settled: {formatDate(lease.last_settled_at)}</div>
        {lease.acknowledged_at && <div>Acknowledged: {formatDate(lease.acknowledged_at)}</div>}
        {lease.closed_at && (
          <div>
            Closed: {formatDate(lease.closed_at)}
            {lease.closure_reason && <span className="text-muted"> - {lease.closure_reason}</span>}
          </div>
        )}
        {lease.rejected_at && (
          <div className="text-error">
            Rejected: {formatDate(lease.rejected_at)}
            {lease.rejection_reason && ` - ${lease.rejection_reason}`}
          </div>
        )}
        {lease.expired_at && <div>Expired: {formatDate(lease.expired_at)}</div>}
      </div>
    </div>
  );
}

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

  const providerSKUs = selectedProvider
    ? skus.filter((s) => s.provider_uuid === selectedProvider)
    : [];

  // Compute hash when payload changes
  useEffect(() => {
    const computeHash = async () => {
      if (!payloadText) {
        setPayloadHash(null);
        setPayloadError(null);
        return;
      }

      if (!validatePayloadSize(payloadText)) {
        setPayloadHash(null);
        setPayloadError(`Payload exceeds maximum size of ${MAX_PAYLOAD_SIZE / 1024}KB`);
        return;
      }

      try {
        const hash = await sha256(payloadText);
        setPayloadHash(toHex(hash));
        setPayloadError(null);
      } catch {
        setPayloadHash(null);
        setPayloadError('Failed to compute hash');
      }
    };

    computeHash();
  }, [payloadText]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file before reading
    const validation = validateFile(file);
    if (!validation.valid) {
      setPayloadError(validation.error || 'Invalid file');
      // Reset input
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setPayloadText(content);
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
      if (payloadText && payloadHash) {
        const payloadBytes = new TextEncoder().encode(payloadText);
        const hashBytes = await sha256(payloadText);
        onSubmit(validItems, payloadBytes, hashBytes, selectedProvider);
      } else {
        onSubmit(validItems);
      }
    }
  };

  const calculateEstimatedCost = () => {
    let total = 0;
    let denom = '';
    let unit = '';

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
    const unitLabel = unit === 'UNIT_PER_HOUR' ? '/hr' : '/day';
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${meta.symbol}${unitLabel}`;
  };

  const estimatedCost = calculateEstimatedCost();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="card-static w-full max-w-lg p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-heading font-semibold">Create Lease</h3>
          <button onClick={onClose} className="text-muted hover:text-primary" disabled={loading}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
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
                  {formatAddress(p.address)}
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
                <div className="space-y-3">
                  {items.map((item, idx) => {
                    return (
                      <div key={idx} className="flex gap-2">
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
                            ✕
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Deployment Payload (optional) */}
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
                placeholder="Paste your deployment manifest here (YAML, JSON, etc.)..."
                rows={5}
                className="input w-full font-mono text-sm"
                disabled={loading}
              />
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className={payloadError ? 'text-error' : 'text-dim'}>
                  {payloadError || `${getPayloadSize(payloadText).toLocaleString()} / ${(MAX_PAYLOAD_SIZE / 1024).toFixed(0)}KB`}
                </span>
                {payloadHash && (
                  <span className="font-mono text-dim" title={payloadHash}>
                    SHA-256: {payloadHash.slice(0, 16)}...
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

          <div className="flex justify-end gap-3 pt-4">
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
