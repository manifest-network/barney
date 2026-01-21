import { useState, useEffect, useCallback } from 'react';
import { useChain } from '@cosmos-kit/react';
import type { Lease, LeaseState } from '../../api/billing';
import { getLeasesByTenant, getBillingParams } from '../../api/billing';
import { getProviders, getSKUs, type Provider, type SKU } from '../../api/sku';
import { createLease, cancelLease, closeLease, type TxResult } from '../../api/tx';
import { DENOM_METADATA, formatPrice } from '../../api/config';
import {
  createSignMessage,
  createAuthToken,
  getLeaseConnectionInfo,
  type ConnectionInfo,
} from '../../api/provider-api';

const CHAIN_NAME = 'manifestlocal';

const stateColors: Record<LeaseState, { bg: string; text: string }> = {
  LEASE_STATE_UNSPECIFIED: { bg: 'bg-gray-700', text: 'text-gray-400' },
  LEASE_STATE_PENDING: { bg: 'bg-yellow-900/50', text: 'text-yellow-400' },
  LEASE_STATE_ACTIVE: { bg: 'bg-green-900/50', text: 'text-green-400' },
  LEASE_STATE_CLOSED: { bg: 'bg-gray-700', text: 'text-gray-400' },
  LEASE_STATE_REJECTED: { bg: 'bg-red-900/50', text: 'text-red-400' },
  LEASE_STATE_EXPIRED: { bg: 'bg-gray-700', text: 'text-gray-500' },
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
  const { address, isWalletConnected, openView, getOfflineSigner } = useChain(CHAIN_NAME);

  const [stateFilter, setStateFilter] = useState<LeaseState | 'all'>('all');
  const [showCreateLease, setShowCreateLease] = useState(false);
  const [leases, setLeases] = useState<Lease[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [skus, setSKUs] = useState<SKU[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInAllowedList, setIsInAllowedList] = useState(false);
  const [txStatus, setTxStatus] = useState<{ loading: boolean; message: string } | null>(null);

  const fetchData = useCallback(async () => {
    if (!address) {
      setLeases([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
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
  }, [address]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const getSKU = (uuid: string) => skus.find((s) => s.uuid === uuid);
  const getProvider = (uuid: string) => providers.find((p) => p.uuid === uuid);

  const filteredLeases =
    stateFilter === 'all' ? leases : leases.filter((l) => l.state === stateFilter);

  const handleCancelLease = async (leaseUuid: string) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxStatus({ loading: true, message: 'Cancelling lease...' });

      const result: TxResult = await cancelLease(signer, address, [leaseUuid]);

      if (result.success) {
        setTxStatus({ loading: false, message: `Lease cancelled! Tx: ${result.transactionHash}` });
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

  const handleCreateLease = async (items: { skuUuid: string; quantity: number }[]) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxStatus({ loading: true, message: 'Creating lease...' });

      const result: TxResult = await createLease(signer, address, items);

      if (result.success) {
        setTxStatus({ loading: false, message: `Lease created! Tx: ${result.transactionHash}` });
        setShowCreateLease(false);
        await fetchData();
      } else {
        setTxStatus({ loading: false, message: `Failed: ${result.error}` });
      }
    } catch (err) {
      setTxStatus({ loading: false, message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` });
    }
  };

  if (!isWalletConnected) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-8 text-center">
        <p className="mb-4 text-gray-400">Connect your wallet to view and manage your leases</p>
        <button
          onClick={() => openView()}
          className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-400">Loading leases...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-700 bg-red-900/20 p-4 text-red-400">
        Error: {error}
        <button onClick={fetchData} className="ml-4 text-blue-400 hover:text-blue-300">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Billing Module Status */}
      {isInAllowedList && (
        <div className="rounded-lg border border-blue-700 bg-blue-900/20 p-4">
          <div className="flex items-center gap-2">
            <span className="text-blue-400">★</span>
            <span className="font-medium text-blue-300">Billing Module Admin</span>
          </div>
          <p className="mt-1 text-sm text-blue-400/80">
            Your wallet is in the billing module allowed list.
          </p>
        </div>
      )}

      {/* Transaction Status */}
      {txStatus && (
        <div
          className={`rounded-lg border p-4 ${
            txStatus.loading
              ? 'border-blue-700 bg-blue-900/20 text-blue-300'
              : txStatus.message.includes('Failed') || txStatus.message.includes('Error')
              ? 'border-red-700 bg-red-900/20 text-red-300'
              : 'border-green-700 bg-green-900/20 text-green-300'
          }`}
        >
          {txStatus.loading && <span className="mr-2">⏳</span>}
          {txStatus.message}
          {!txStatus.loading && (
            <button
              onClick={() => setTxStatus(null)}
              className="ml-4 text-gray-400 hover:text-white"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">Filter:</span>
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as LeaseState | 'all')}
            className="rounded border border-gray-600 bg-gray-700 px-3 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
          >
            <option value="all">All States</option>
            <option value="LEASE_STATE_PENDING">Pending</option>
            <option value="LEASE_STATE_ACTIVE">Active</option>
            <option value="LEASE_STATE_CLOSED">Closed</option>
            <option value="LEASE_STATE_REJECTED">Rejected</option>
            <option value="LEASE_STATE_EXPIRED">Expired</option>
          </select>
          <button
            onClick={fetchData}
            className="rounded border border-gray-600 px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-700 hover:text-white"
          >
            Refresh
          </button>
        </div>
        <button
          onClick={() => setShowCreateLease(true)}
          disabled={providers.length === 0}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          + Create Lease
        </button>
      </div>

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
          return (
            <div key={state} className="rounded-lg border border-gray-700 bg-gray-800 p-4">
              <div className="text-2xl font-bold text-white">{count}</div>
              <div className={`text-sm ${stateColors[state].text}`}>{stateLabels[state]}</div>
            </div>
          );
        })}
      </div>

      {/* Leases List */}
      <div className="space-y-4">
        {filteredLeases.length === 0 ? (
          <div className="rounded-lg border border-gray-700 bg-gray-800 p-8 text-center">
            <p className="text-gray-400">No leases found</p>
            {providers.length > 0 ? (
              <button
                onClick={() => setShowCreateLease(true)}
                className="mt-4 text-blue-400 hover:text-blue-300"
              >
                Create your first lease
              </button>
            ) : (
              <p className="mt-2 text-sm text-gray-500">No active providers available</p>
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
              txLoading={txStatus?.loading || false}
              tenantAddress={address}
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
          loading={txStatus?.loading || false}
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
}: {
  lease: Lease;
  getSKU: (uuid: string) => SKU | undefined;
  getProvider: (uuid: string) => Provider | undefined;
  onCancel: (uuid: string) => void;
  onClose: (uuid: string, reason?: string) => void;
  txLoading: boolean;
  tenantAddress?: string;
}) {
  const { signArbitrary } = useChain(CHAIN_NAME);

  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [closeReason, setCloseReason] = useState('');

  const provider = getProvider(lease.provider_uuid);
  const colors = stateColors[lease.state];

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

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-gray-400">{lease.uuid}</span>
            <button
              onClick={() => copyToClipboard(lease.uuid)}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              Copy
            </button>
            <span className={`rounded px-2 py-0.5 text-xs ${colors.bg} ${colors.text}`}>
              {stateLabels[lease.state]}
            </span>
          </div>
          <div className="mt-1 text-sm text-gray-500">
            Provider: {provider ? formatAddress(provider.address) : lease.provider_uuid}
          </div>
        </div>
        <div className="flex gap-2">
          {lease.state === 'LEASE_STATE_PENDING' && (
            <button
              onClick={() => onCancel(lease.uuid)}
              disabled={txLoading}
              className="rounded border border-red-600 px-3 py-1 text-sm text-red-400 hover:bg-red-900/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          {lease.state === 'LEASE_STATE_ACTIVE' && (
            <>
              <button
                onClick={handleGetConnectionInfo}
                disabled={connectionLoading || !provider?.api_url}
                className="rounded border border-blue-600 px-3 py-1 text-sm text-blue-400 hover:bg-blue-900/20 disabled:cursor-not-allowed disabled:opacity-50"
                title={!provider?.api_url ? 'Provider has no API URL configured' : undefined}
              >
                {connectionLoading ? 'Loading...' : 'Get Connection'}
              </button>
              <button
                onClick={() => setShowCloseForm(!showCloseForm)}
                disabled={txLoading}
                className="rounded border border-orange-600 px-3 py-1 text-sm text-orange-400 hover:bg-orange-900/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Close
              </button>
            </>
          )}
        </div>
      </div>

      {/* Connection Info */}
      {connectionError && (
        <div className="mb-4 rounded border border-red-600/30 bg-red-900/10 p-3 text-sm text-red-400">
          {connectionError}
          <button
            onClick={() => setConnectionError(null)}
            className="ml-2 text-gray-400 hover:text-white"
          >
            ✕
          </button>
        </div>
      )}

      {connectionInfo && (
        <div className="mb-4 rounded border border-blue-600/30 bg-blue-900/10 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase text-blue-400">Connection Info</span>
            <button
              onClick={() => setConnectionInfo(null)}
              className="text-gray-400 hover:text-white"
            >
              ✕
            </button>
          </div>
          <div className="space-y-1 text-sm">
            <div>
              <span className="text-gray-400">Host: </span>
              <span className="font-mono text-white">{connectionInfo.connection.host}</span>
            </div>
            <div>
              <span className="text-gray-400">Port: </span>
              <span className="font-mono text-white">{connectionInfo.connection.port}</span>
            </div>
            <div>
              <span className="text-gray-400">Protocol: </span>
              <span className="font-mono text-white">{connectionInfo.connection.protocol}</span>
            </div>
            {connectionInfo.connection.metadata && (
              <div>
                <span className="text-gray-400">Metadata: </span>
                <span className="font-mono text-white">
                  {JSON.stringify(connectionInfo.connection.metadata)}
                </span>
              </div>
            )}
            <div className="mt-2">
              <button
                onClick={() => {
                  const url = `${connectionInfo.connection.protocol}://${connectionInfo.connection.host}:${connectionInfo.connection.port}`;
                  copyToClipboard(url);
                }}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                Copy URL
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Close Form */}
      {showCloseForm && (
        <div className="mb-4 rounded border border-orange-600/30 bg-orange-900/10 p-3">
          <label className="mb-1 block text-sm text-gray-400">Closure Reason (optional)</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              placeholder="e.g., No longer needed"
              maxLength={256}
              className="flex-1 rounded border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none"
              disabled={txLoading}
            />
            <button
              onClick={() => {
                onClose(lease.uuid, closeReason || undefined);
                setShowCloseForm(false);
                setCloseReason('');
              }}
              disabled={txLoading}
              className="rounded bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Confirm Close
            </button>
            <button
              onClick={() => {
                setShowCloseForm(false);
                setCloseReason('');
              }}
              disabled={txLoading}
              className="rounded border border-gray-600 px-3 py-2 text-sm text-gray-400 hover:bg-gray-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Lease Items */}
      <div className="mb-4 rounded bg-gray-700/30 p-3">
        <div className="mb-2 text-xs font-medium uppercase text-gray-500">Items</div>
        <div className="space-y-2">
          {lease.items.map((item, idx) => {
            const sku = getSKU(item.sku_uuid);
            const pricePerHour =
              (parseInt(item.locked_price.amount, 10) * 3600) /
              Math.pow(10, DENOM_METADATA[item.locked_price.denom]?.exponent || 6);
            const symbol = DENOM_METADATA[item.locked_price.denom]?.symbol || item.locked_price.denom;

            return (
              <div key={idx} className="flex items-center justify-between text-sm">
                <span className="text-white">
                  {sku?.name || item.sku_uuid} × {item.quantity}
                </span>
                <span className="text-gray-400">
                  {pricePerHour.toFixed(4)} {symbol}/hr each
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-3 border-t border-gray-600 pt-2 text-right">
          <span className="text-sm text-gray-400">Total: </span>
          <span className="font-medium text-green-400">{calculateTotalPerHour()}</span>
        </div>
      </div>

      {/* Timestamps */}
      <div className="grid gap-2 text-xs text-gray-500 sm:grid-cols-2">
        <div>Created: {formatDate(lease.created_at)}</div>
        <div>Last Settled: {formatDate(lease.last_settled_at)}</div>
        {lease.acknowledged_at && <div>Acknowledged: {formatDate(lease.acknowledged_at)}</div>}
        {lease.closed_at && (
          <div>
            Closed: {formatDate(lease.closed_at)}
            {lease.closure_reason && <span className="text-gray-400"> - {lease.closure_reason}</span>}
          </div>
        )}
        {lease.rejected_at && (
          <div className="text-red-400">
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
  onSubmit: (items: { skuUuid: string; quantity: number }[]) => void;
  loading: boolean;
}) {
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [items, setItems] = useState<{ skuUuid: string; quantity: number }[]>([
    { skuUuid: '', quantity: 1 },
  ]);

  const providerSKUs = selectedProvider
    ? skus.filter((s) => s.provider_uuid === selectedProvider)
    : [];

  const addItem = () => setItems([...items, { skuUuid: '', quantity: 1 }]);
  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));
  const updateItem = (idx: number, field: 'skuUuid' | 'quantity', value: string | number) => {
    setItems(items.map((item, i) => (i === idx ? { ...item, [field]: value } : item)));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const validItems = items.filter((item) => item.skuUuid && item.quantity > 0);
    if (validItems.length > 0) {
      onSubmit(validItems);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg border border-gray-700 bg-gray-800 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">Create Lease</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white" disabled={loading}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Provider Selection */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">Provider</label>
            <select
              value={selectedProvider}
              onChange={(e) => {
                setSelectedProvider(e.target.value);
                setItems([{ skuUuid: '', quantity: 1 }]);
              }}
              className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
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
                <label className="text-sm text-gray-400">SKU Items</label>
                <button
                  type="button"
                  onClick={addItem}
                  className="text-sm text-blue-400 hover:text-blue-300"
                  disabled={loading}
                >
                  + Add Item
                </button>
              </div>
              {providerSKUs.length === 0 ? (
                <p className="text-sm text-gray-500">No active SKUs for this provider</p>
              ) : (
                <div className="space-y-3">
                  {items.map((item, idx) => {
                    return (
                      <div key={idx} className="flex gap-2">
                        <select
                          value={item.skuUuid}
                          onChange={(e) => updateItem(idx, 'skuUuid', e.target.value)}
                          className="flex-1 rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
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
                          className="w-20 rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                          disabled={loading}
                        />
                        {items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeItem(idx)}
                            className="px-2 text-red-400 hover:text-red-300"
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

          {/* Estimated Cost */}
          {estimatedCost && (
            <div className="rounded bg-gray-700/50 p-3">
              <div className="text-sm text-gray-400">Estimated Cost</div>
              <div className="text-lg font-medium text-green-400">{estimatedCost}</div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-400 hover:text-white"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !selectedProvider || items.some((i) => !i.skuUuid)}
              className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Lease'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
