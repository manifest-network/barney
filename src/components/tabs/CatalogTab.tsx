import { useState, useEffect, useCallback } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Link, Package, Shield, Loader2, RefreshCw, Plus } from 'lucide-react';
import { HEALTH_CHECK_TIMEOUT_MS, POST_TX_REFETCH_DELAY_MS } from '../../config/constants';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { truncateAddress } from '../../utils/address';
import {
  getProviders,
  getSKUs,
  getSKUsByProvider,
  getSKUParams,
  createProvider,
  updateProvider,
  createSKU,
  updateSKU,
  deactivateProvider,
  deactivateSKU,
  Unit,
  DENOMS,
  formatPrice,
} from '../../api';
import type { Provider, SKU, SKUParams } from '../../api/sku';
import { getProviderHealth } from '../../api/provider-api';
import { getLeasesBySKU, LeaseState } from '../../api/billing';
import { useToast } from '../../hooks/useToast';
import { EmptyState } from '../ui/EmptyState';
import { Modal } from '../ui/Modal';

type HealthStatus = 'healthy' | 'unhealthy' | 'loading' | 'unknown';


const CHAIN_NAME = 'manifestlocal';

interface CatalogTabProps {
  isConnected: boolean;
  address?: string;
  onConnect: () => void;
}

export function CatalogTab({ isConnected, address, onConnect }: CatalogTabProps) {
  const { getOfflineSignerDirect } = useChain(CHAIN_NAME);
  const toast = useToast();
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [showCreateProvider, setShowCreateProvider] = useState(false);
  const [showCreateSKU, setShowCreateSKU] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [editingSKU, setEditingSKU] = useState<SKU | null>(null);

  const [providers, setProviders] = useState<Provider[]>([]);
  const [skus, setSkus] = useState<SKU[]>([]);
  const [skuParams, setSkuParams] = useState<SKUParams | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Using objects instead of Maps for better React performance (referential equality)
  const [providerHealth, setProviderHealth] = useState<Record<string, HealthStatus>>({});
  const [skuUsage, setSkuUsage] = useState<Record<string, { active: number; total: number }>>({});
  const [skuUsageLoading, setSkuUsageLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [fetchedProviders, fetchedSkus, fetchedParams] = await Promise.all([
        getProviders(!showInactive),
        selectedProvider
          ? getSKUsByProvider(selectedProvider, !showInactive)
          : getSKUs(!showInactive),
        getSKUParams().catch(() => null),
      ]);

      setProviders(fetchedProviders);
      setSkus(fetchedSkus);
      setSkuParams(fetchedParams);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [showInactive, selectedProvider]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Fetch SKU usage stats (non-blocking, with loading state)
  useEffect(() => {
    const fetchSkuUsage = async () => {
      if (skus.length === 0) return;

      setSkuUsageLoading(true);
      const usageRecord: Record<string, { active: number; total: number }> = {};

      await Promise.all(
        skus.map(async (sku) => {
          try {
            const [activeLeases, allLeases] = await Promise.all([
              getLeasesBySKU(sku.uuid, LeaseState.LEASE_STATE_ACTIVE),
              getLeasesBySKU(sku.uuid),
            ]);
            usageRecord[sku.uuid] = {
              active: activeLeases.length,
              total: allLeases.length,
            };
          } catch {
            // Ignore errors for individual SKU queries
          }
        })
      );

      setSkuUsage(usageRecord);
      setSkuUsageLoading(false);
    };

    fetchSkuUsage();
  }, [skus]);

  // Fetch health status for providers with api_url (non-blocking)
  useEffect(() => {
    const abortController = new AbortController();

    const checkHealth = async () => {
      const providersWithApi = providers.filter((p) => p.api_url && p.active);
      if (providersWithApi.length === 0) return;

      // Set loading state for all providers with API
      setProviderHealth((prev) => {
        const next = { ...prev };
        for (const p of providersWithApi) {
          if (!(p.uuid in next)) {
            next[p.uuid] = 'loading';
          }
        }
        return next;
      });

      // Check health in parallel with abort support
      const results = await Promise.all(
        providersWithApi.map(async (p) => {
          const health = await getProviderHealth(p.api_url, HEALTH_CHECK_TIMEOUT_MS, abortController.signal);
          return { uuid: p.uuid, status: health?.status === 'healthy' ? 'healthy' : 'unhealthy' } as const;
        })
      );

      // Only update state if not aborted
      if (!abortController.signal.aborted) {
        setProviderHealth((prev) => {
          const next = { ...prev };
          for (const r of results) {
            next[r.uuid] = r.status;
          }
          return next;
        });
      }
    };

    checkHealth();

    // Cleanup: abort in-flight requests when dependencies change or unmount
    return () => {
      abortController.abort();
    };
  }, [providers]);

  const getProviderName = (uuid: string) => {
    const provider = providers.find((p) => p.uuid === uuid);
    return provider ? truncateAddress(provider.address) : 'Unknown';
  };

  const isInSKUAllowedList = address && skuParams?.allowed_list?.includes(address);

  const handleDeactivateProvider = async (uuid: string) => {
    if (!address) return;

    const signer = getOfflineSignerDirect();
    if (!signer) {
      toast.error('Failed to get signer');
      return;
    }

    const result = await deactivateProvider(signer, address, uuid);
    if (result.success) {
      toast.success(`Provider deactivated! Tx: ${result.transactionHash?.slice(0, 16)}...`);
      setTimeout(fetchData, POST_TX_REFETCH_DELAY_MS);
    } else {
      toast.error(result.error || 'Failed to deactivate provider');
    }
  };

  const handleDeactivateSKU = async (uuid: string) => {
    if (!address) return;

    const signer = getOfflineSignerDirect();
    if (!signer) {
      toast.error('Failed to get signer');
      return;
    }

    const result = await deactivateSKU(signer, address, uuid);
    if (result.success) {
      toast.success(`SKU deactivated! Tx: ${result.transactionHash?.slice(0, 16)}...`);
      setTimeout(fetchData, POST_TX_REFETCH_DELAY_MS);
    } else {
      toast.error(result.error || 'Failed to deactivate SKU');
    }
  };

  const handleCreateProvider = async (params: { address: string; payoutAddress: string; apiUrl: string }) => {
    if (!address) return;

    const signer = getOfflineSignerDirect();
    if (!signer) {
      toast.error('Failed to get signer');
      return;
    }

    const result = await createProvider(signer, address, params);
    if (result.success) {
      toast.success(`Provider created! Tx: ${result.transactionHash?.slice(0, 16)}...`);
      setShowCreateProvider(false);
      setTimeout(fetchData, POST_TX_REFETCH_DELAY_MS);
    } else {
      toast.error(result.error || 'Failed to create provider');
    }
  };

  const handleUpdateProvider = async (params: { uuid: string; address: string; payoutAddress: string; apiUrl: string; active: boolean }) => {
    if (!address) return;

    const signer = getOfflineSignerDirect();
    if (!signer) {
      toast.error('Failed to get signer');
      return;
    }

    const result = await updateProvider(signer, address, params);
    if (result.success) {
      toast.success(`Provider updated! Tx: ${result.transactionHash?.slice(0, 16)}...`);
      setEditingProvider(null);
      setTimeout(fetchData, POST_TX_REFETCH_DELAY_MS);
    } else {
      toast.error(result.error || 'Failed to update provider');
    }
  };

  const handleCreateSKU = async (params: { providerUuid: string; name: string; unit: number; priceAmount: string; priceDenom: string }) => {
    if (!address) return;

    const signer = getOfflineSignerDirect();
    if (!signer) {
      toast.error('Failed to get signer');
      return;
    }

    const result = await createSKU(signer, address, {
      providerUuid: params.providerUuid,
      name: params.name,
      unit: params.unit,
      basePrice: { denom: params.priceDenom, amount: params.priceAmount },
    });

    if (result.success) {
      toast.success(`SKU created! Tx: ${result.transactionHash?.slice(0, 16)}...`);
      setShowCreateSKU(false);
      setTimeout(fetchData, POST_TX_REFETCH_DELAY_MS);
    } else {
      toast.error(result.error || 'Failed to create SKU');
    }
  };

  const handleUpdateSKU = async (params: { uuid: string; providerUuid: string; name: string; unit: number; priceAmount: string; priceDenom: string; active: boolean }) => {
    if (!address) return;

    const signer = getOfflineSignerDirect();
    if (!signer) {
      toast.error('Failed to get signer');
      return;
    }

    const result = await updateSKU(signer, address, {
      uuid: params.uuid,
      providerUuid: params.providerUuid,
      name: params.name,
      unit: params.unit,
      basePrice: { denom: params.priceDenom, amount: params.priceAmount },
      active: params.active,
    });

    if (result.success) {
      toast.success(`SKU updated! Tx: ${result.transactionHash?.slice(0, 16)}...`);
      setEditingSKU(null);
      setTimeout(fetchData, POST_TX_REFETCH_DELAY_MS);
    } else {
      toast.error(result.error || 'Failed to update SKU');
    }
  };

  if (!isConnected) {
    return (
      <EmptyState
        icon={Link}
        title="Connect Your Wallet"
        description="Connect your wallet to manage providers and SKUs"
        action={{ label: 'Connect Wallet', onClick: onConnect }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Error Banner */}
      {error && (
        <div className="card-static p-4 border-error-500/50 bg-error-500/10">
          <span className="text-error">{error}</span>
          <button onClick={fetchData} className="ml-4 text-primary-400 hover:underline">
            Retry
          </button>
        </div>
      )}


      {/* SKU Module Access Banner */}
      {isConnected && (
        <div
          className={`card-static p-4 ${
            isInSKUAllowedList
              ? 'border-purple-700 bg-purple-900/20'
              : ''
          }`}
        >
          <div className="flex items-center gap-3">
            {isInSKUAllowedList ? (
              <>
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600">
                  <Shield size={16} className="text-white" />
                </div>
                <div>
                  <div className="font-medium text-purple-300">SKU Module Admin</div>
                  <div className="text-sm text-muted">
                    Your wallet is in the SKU module allowed list. You can create and manage providers and SKUs.
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-600">
                  <Package size={16} className="text-muted" />
                </div>
                <div>
                  <div className="font-medium text-gray-300">Read-Only Access</div>
                  <div className="text-sm text-dim">
                    Your wallet is not in the SKU module allowed list. You can view providers and SKUs but cannot create or modify them.
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="show-inactive-checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded border-gray-600 bg-gray-700"
              aria-describedby="show-inactive-description"
            />
            <label htmlFor="show-inactive-checkbox" className="text-sm text-muted">
              Show inactive
            </label>
            <span id="show-inactive-description" className="sr-only">
              Toggle to show or hide inactive providers and SKUs
            </span>
          </div>
          <button
            onClick={fetchData}
            disabled={loading}
            className="btn btn-secondary btn-sm disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 className="animate-spin" size={14} />
                Loading...
              </>
            ) : (
              <>
                <RefreshCw size={14} />
                Refresh
              </>
            )}
          </button>
        </div>
        <div className="flex gap-2">
          {isConnected && isInSKUAllowedList && (
            <>
              <button
                onClick={() => setShowCreateProvider(true)}
                className="btn btn-primary"
              >
                <Plus size={16} />
                Create Provider
              </button>
              <button
                onClick={() => setShowCreateSKU(true)}
                disabled={providers.filter((p) => p.active).length === 0}
                className="btn btn-success disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus size={16} />
                Create SKU
              </button>
            </>
          )}
        </div>
      </div>

      {/* Providers Section */}
      <div className="card-static p-6">
        <h2 className="mb-4 text-lg font-heading font-semibold">Providers</h2>
        {loading && providers.length === 0 ? (
          <div className="text-muted">Loading providers...</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <button
              onClick={() => setSelectedProvider(null)}
              className={`rounded-lg border p-4 text-left transition-colors ${
                selectedProvider === null
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-gray-600 hover:border-gray-500'
              }`}
            >
              <div className="font-medium text-white">All Providers</div>
              <div className="text-sm text-muted">{providers.length} providers</div>
            </button>
            {providers.map((provider) => (
              <ProviderCard
                key={provider.uuid}
                provider={provider}
                isSelected={selectedProvider === provider.uuid}
                onSelect={() => setSelectedProvider(provider.uuid)}
                onEdit={isInSKUAllowedList ? () => setEditingProvider(provider) : undefined}
                onDeactivate={isInSKUAllowedList ? () => handleDeactivateProvider(provider.uuid) : undefined}
                healthStatus={providerHealth[provider.uuid]}
              />
            ))}
          </div>
        )}
      </div>

      {/* SKUs Section */}
      <div className="card-static p-6">
        <h2 className="mb-4 text-lg font-heading font-semibold">
          SKUs {selectedProvider && `(${getProviderName(selectedProvider)})`}
        </h2>
        {loading && skus.length === 0 ? (
          <div className="text-muted">Loading SKUs...</div>
        ) : skus.length === 0 ? (
          <p className="text-muted">No SKUs found</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-700 text-left text-sm text-muted">
                  <th className="pb-3 pr-4">Name</th>
                  <th className="pb-3 pr-4">Provider</th>
                  <th className="pb-3 pr-4">Price</th>
                  <th className="pb-3 pr-4">Usage</th>
                  <th className="pb-3 pr-4">Status</th>
                  <th className="pb-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {skus.map((sku) => (
                  <SKURow
                    key={sku.uuid}
                    sku={sku}
                    providerName={getProviderName(sku.provider_uuid)}
                    formatPrice={formatPrice}
                    usage={skuUsage[sku.uuid]}
                    usageLoading={skuUsageLoading && !(sku.uuid in skuUsage)}
                    onEdit={isInSKUAllowedList ? () => setEditingSKU(sku) : undefined}
                    onDeactivate={isInSKUAllowedList ? () => handleDeactivateSKU(sku.uuid) : undefined}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Provider Modal */}
      <Modal
        isOpen={showCreateProvider}
        onClose={() => setShowCreateProvider(false)}
        title="Create Provider"
      >
        <CreateProviderForm
          defaultAddress={address}
          onSubmit={handleCreateProvider}
          onClose={() => setShowCreateProvider(false)}
        />
      </Modal>

      {/* Create SKU Modal */}
      <Modal
        isOpen={showCreateSKU}
        onClose={() => setShowCreateSKU(false)}
        title="Create SKU"
      >
        <CreateSKUForm
          providers={providers}
          onSubmit={handleCreateSKU}
          onClose={() => setShowCreateSKU(false)}
        />
      </Modal>

      {/* Edit Provider Modal */}
      <Modal
        isOpen={!!editingProvider}
        onClose={() => setEditingProvider(null)}
        title="Edit Provider"
      >
        {editingProvider && (
          <EditProviderForm
            provider={editingProvider}
            onSubmit={handleUpdateProvider}
            onClose={() => setEditingProvider(null)}
          />
        )}
      </Modal>

      {/* Edit SKU Modal */}
      <Modal
        isOpen={!!editingSKU}
        onClose={() => setEditingSKU(null)}
        title="Edit SKU"
      >
        {editingSKU && (
          <EditSKUForm
            sku={editingSKU}
            providers={providers}
            onSubmit={handleUpdateSKU}
            onClose={() => setEditingSKU(null)}
          />
        )}
      </Modal>
    </div>
  );
}

function ProviderCard({
  provider,
  isSelected,
  onSelect,
  onEdit,
  onDeactivate,
  healthStatus,
}: {
  provider: Provider;
  isSelected: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onDeactivate?: () => void;
  healthStatus?: HealthStatus;
}) {
  const { copied, copyToClipboard } = useCopyToClipboard();

  const handleCopyUuid = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await copyToClipboard(provider.uuid);
  };

  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${
        isSelected
          ? 'border-blue-500 bg-blue-500/10'
          : 'border-gray-600 hover:border-gray-500'
      }`}
    >
      <button onClick={onSelect} className="w-full text-left">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <div className="font-medium text-white" title={provider.address}>
              {truncateAddress(provider.address)}
            </div>
            {provider.api_url && healthStatus && (
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  healthStatus === 'healthy'
                    ? 'bg-green-500'
                    : healthStatus === 'loading'
                    ? 'bg-yellow-500 animate-pulse'
                    : 'bg-red-500'
                }`}
                title={
                  healthStatus === 'healthy'
                    ? 'Provider API is healthy'
                    : healthStatus === 'loading'
                    ? 'Checking provider health...'
                    : 'Provider API is unreachable'
                }
              />
            )}
          </div>
          {!provider.active && (
            <span className="badge badge-secondary">Inactive</span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-1">
          <button
            onClick={handleCopyUuid}
            className="font-mono text-xs text-dim hover:text-gray-300"
            title={`Click to copy: ${provider.uuid}`}
          >
            {provider.uuid}
            <span className="ml-1 text-gray-600">{copied ? '(copied!)' : '(copy)'}</span>
          </button>
        </div>
        <div className="mt-2 truncate text-xs text-dim">{provider.api_url || 'No API URL'}</div>
      </button>
      {(onEdit || onDeactivate) && (
        <div className="mt-2 flex gap-3">
          {onEdit && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              Edit
            </button>
          )}
          {onDeactivate && provider.active && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeactivate();
              }}
              className="text-xs text-red-400 hover:text-red-300"
            >
              Deactivate
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SKURow({
  sku,
  providerName,
  formatPrice,
  usage,
  usageLoading,
  onEdit,
  onDeactivate,
}: {
  sku: SKU;
  providerName: string;
  formatPrice: (amount: string, denom: string, unit?: Unit) => string;
  usage?: { active: number; total: number };
  usageLoading?: boolean;
  onEdit?: () => void;
  onDeactivate?: () => void;
}) {
  const { copied, copyToClipboard } = useCopyToClipboard();

  const handleCopyUuid = async () => {
    await copyToClipboard(sku.uuid);
  };

  return (
    <tr className="border-b border-gray-700/50">
      <td className="py-3 pr-4">
        <div className="font-medium text-white">{sku.name}</div>
        <button
          onClick={handleCopyUuid}
          className="font-mono text-xs text-dim hover:text-gray-300"
          title={`Click to copy: ${sku.uuid}`}
        >
          {sku.uuid}
          <span className="ml-1 text-gray-600">{copied ? '(copied!)' : '(copy)'}</span>
        </button>
      </td>
      <td className="py-3 pr-4 text-sm text-gray-300">{providerName}</td>
      <td className="py-3 pr-4">
        <span className="font-medium text-green-400">
          {formatPrice(sku.base_price.amount, sku.base_price.denom, sku.unit)}
        </span>
      </td>
      <td className="py-3 pr-4">
        {usageLoading ? (
          <span className="text-gray-600 animate-pulse">Loading...</span>
        ) : usage ? (
          <div className="text-sm">
            <span className="text-green-400">{usage.active}</span>
            <span className="text-dim"> / {usage.total}</span>
            <span className="ml-1 text-xs text-gray-600">leases</span>
          </div>
        ) : (
          <span className="text-gray-600">-</span>
        )}
      </td>
      <td className="py-3 pr-4">
        {sku.active ? (
          <span className="badge badge-success">Active</span>
        ) : (
          <span className="badge badge-secondary">Inactive</span>
        )}
      </td>
      <td className="py-3">
        <div className="flex gap-3">
          {onEdit && (
            <button
              onClick={onEdit}
              className="text-sm text-blue-400 hover:text-blue-300"
            >
              Edit
            </button>
          )}
          {onDeactivate && sku.active && (
            <button
              onClick={onDeactivate}
              className="text-sm text-red-400 hover:text-red-300"
            >
              Deactivate
            </button>
          )}
          {!onEdit && !onDeactivate && (
            <span className="text-sm text-gray-600">-</span>
          )}
        </div>
      </td>
    </tr>
  );
}


function CreateProviderForm({
  defaultAddress,
  onSubmit,
  onClose,
}: {
  defaultAddress?: string;
  onSubmit: (params: { address: string; payoutAddress: string; apiUrl: string }) => void;
  onClose: () => void;
}) {
  const [address, setAddress] = useState(defaultAddress || '');
  const [payoutAddress, setPayoutAddress] = useState(defaultAddress || '');
  const [apiUrl, setApiUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await onSubmit({ address, payoutAddress, apiUrl });
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm text-muted">Management Address</label>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="manifest1..."
          required
          className="input"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">Payout Address</label>
        <input
          type="text"
          value={payoutAddress}
          onChange={(e) => setPayoutAddress(e.target.value)}
          placeholder="manifest1..."
          required
          className="input"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">API URL</label>
        <input
          type="url"
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          placeholder="https://..."
          className="input"
        />
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="px-4 py-2 text-muted hover:text-white">
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !address || !payoutAddress}
          className="btn btn-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Creating...' : 'Create Provider'}
        </button>
      </div>
    </form>
  );
}

function CreateSKUForm({
  providers,
  onSubmit,
  onClose,
}: {
  providers: Provider[];
  onSubmit: (params: { providerUuid: string; name: string; unit: number; priceAmount: string; priceDenom: string }) => void;
  onClose: () => void;
}) {
  const activeProviders = providers.filter((p) => p.active);
  const [providerUuid, setProviderUuid] = useState(activeProviders[0]?.uuid || '');
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<number>(Unit.UNIT_PER_HOUR);
  const [priceAmount, setPriceAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await onSubmit({
      providerUuid,
      name,
      unit,
      priceAmount,
      priceDenom: DENOMS.PWR,
    });
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm text-muted">Provider</label>
        <select
          value={providerUuid}
          onChange={(e) => setProviderUuid(e.target.value)}
          required
          className="input select"
        >
          {activeProviders.map((p) => (
            <option key={p.uuid} value={p.uuid}>
              {truncateAddress(p.address)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Small VM"
          required
          className="input"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="create-sku-price" className="mb-1 block text-sm text-muted">Price (uPWR)</label>
          <input
            id="create-sku-price"
            type="number"
            value={priceAmount}
            onChange={(e) => setPriceAmount(e.target.value)}
            placeholder="1000000"
            required
            min="1"
            max="999999999999999"
            aria-label="Price in micro PWR units"
            className="input"
          />
        </div>
        <div>
          <label htmlFor="create-sku-unit" className="mb-1 block text-sm text-muted">Unit</label>
          <select
            id="create-sku-unit"
            value={unit}
            onChange={(e) => setUnit(Number(e.target.value))}
            className="input select"
            aria-label="Billing unit"
          >
            <option value={Unit.UNIT_PER_HOUR}>Per Hour</option>
            <option value={Unit.UNIT_PER_DAY}>Per Day</option>
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="px-4 py-2 text-muted hover:text-white">
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !providerUuid || !name || !priceAmount}
          className="btn btn-success disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Creating...' : 'Create SKU'}
        </button>
      </div>
    </form>
  );
}

function EditProviderForm({
  provider,
  onSubmit,
  onClose,
}: {
  provider: Provider;
  onSubmit: (params: { uuid: string; address: string; payoutAddress: string; apiUrl: string; active: boolean }) => void;
  onClose: () => void;
}) {
  const [address, setAddress] = useState(provider.address);
  const [payoutAddress, setPayoutAddress] = useState(provider.payout_address);
  const [apiUrl, setApiUrl] = useState(provider.api_url || '');
  const [active, setActive] = useState(provider.active);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await onSubmit({ uuid: provider.uuid, address, payoutAddress, apiUrl, active });
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="rounded bg-gray-700/50 p-3 text-xs text-muted">
        <span className="text-dim">UUID: </span>
        <span className="font-mono">{provider.uuid}</span>
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">Management Address</label>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="manifest1..."
          required
          className="input"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">Payout Address</label>
        <input
          type="text"
          value={payoutAddress}
          onChange={(e) => setPayoutAddress(e.target.value)}
          placeholder="manifest1..."
          required
          className="input"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">API URL</label>
        <input
          type="url"
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          placeholder="https://..."
          className="input"
        />
      </div>
      <div>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="rounded border-gray-600 bg-gray-700"
          />
          Active
        </label>
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="px-4 py-2 text-muted hover:text-white">
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !address || !payoutAddress}
          className="btn btn-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Updating...' : 'Update Provider'}
        </button>
      </div>
    </form>
  );
}

function EditSKUForm({
  sku,
  providers,
  onSubmit,
  onClose,
}: {
  sku: SKU;
  providers: Provider[];
  onSubmit: (params: { uuid: string; providerUuid: string; name: string; unit: number; priceAmount: string; priceDenom: string; active: boolean }) => void;
  onClose: () => void;
}) {
  const [providerUuid, setProviderUuid] = useState(sku.provider_uuid);
  const [name, setName] = useState(sku.name);
  const [unit, setUnit] = useState<number>(sku.unit);
  const [priceAmount, setPriceAmount] = useState(sku.base_price.amount);
  const [active, setActive] = useState(sku.active);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await onSubmit({
      uuid: sku.uuid,
      providerUuid,
      name,
      unit,
      priceAmount,
      priceDenom: sku.base_price.denom,
      active,
    });
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="rounded bg-gray-700/50 p-3 text-xs text-muted">
        <span className="text-dim">UUID: </span>
        <span className="font-mono">{sku.uuid}</span>
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">Provider</label>
        <select
          value={providerUuid}
          onChange={(e) => setProviderUuid(e.target.value)}
          required
          className="input select"
        >
          {providers.map((p) => (
            <option key={p.uuid} value={p.uuid}>
              {truncateAddress(p.address)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Small VM"
          required
          className="input"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="edit-sku-price" className="mb-1 block text-sm text-muted">Price (uPWR)</label>
          <input
            id="edit-sku-price"
            type="number"
            value={priceAmount}
            onChange={(e) => setPriceAmount(e.target.value)}
            placeholder="1000000"
            required
            min="1"
            max="999999999999999"
            aria-label="Price in micro PWR units"
            className="input"
          />
        </div>
        <div>
          <label htmlFor="edit-sku-unit" className="mb-1 block text-sm text-muted">Unit</label>
          <select
            id="edit-sku-unit"
            value={unit}
            onChange={(e) => setUnit(Number(e.target.value))}
            className="input select"
            aria-label="Billing unit"
          >
            <option value={Unit.UNIT_PER_HOUR}>Per Hour</option>
            <option value={Unit.UNIT_PER_DAY}>Per Day</option>
          </select>
        </div>
      </div>
      <div>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="rounded border-gray-600 bg-gray-700"
            aria-label="SKU active status"
          />
          Active
        </label>
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="px-4 py-2 text-muted hover:text-white">
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !providerUuid || !name || !priceAmount}
          className="btn btn-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Updating...' : 'Update SKU'}
        </button>
      </div>
    </form>
  );
}
