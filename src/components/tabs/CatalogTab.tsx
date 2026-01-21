import { useState, useEffect, useCallback } from 'react';
import { useChain } from '@cosmos-kit/react';
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

// Format address as manifest1[4chars]...[4chars]
function formatAddress(address: string): string {
  if (!address || address.length < 20) return address;
  const prefix = address.slice(0, 13); // manifest1 + 4 chars
  const suffix = address.slice(-4);
  return `${prefix}...${suffix}`;
}

// Copy text to clipboard
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const CHAIN_NAME = 'manifestlocal';

interface CatalogTabProps {
  isConnected: boolean;
  address?: string;
  onConnect: () => void;
}

export function CatalogTab({ isConnected, address, onConnect }: CatalogTabProps) {
  const { getOfflineSignerDirect } = useChain(CHAIN_NAME);
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
  const [txResult, setTxResult] = useState<{ success: boolean; message: string } | null>(null);

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

  const getProviderName = (uuid: string) => {
    const provider = providers.find((p) => p.uuid === uuid);
    return provider ? formatAddress(provider.address) : 'Unknown';
  };

  const isInSKUAllowedList = address && skuParams?.allowed_list?.includes(address);

  const handleDeactivateProvider = async (uuid: string) => {
    if (!address) return;

    const signer = getOfflineSignerDirect();
    if (!signer) {
      setTxResult({ success: false, message: 'Failed to get signer' });
      return;
    }

    const result = await deactivateProvider(signer, address, uuid);
    if (result.success) {
      setTxResult({ success: true, message: `Provider deactivated! Tx: ${result.transactionHash?.slice(0, 16)}...` });
      setTimeout(fetchData, 1000);
    } else {
      setTxResult({ success: false, message: result.error || 'Failed to deactivate provider' });
    }
  };

  const handleDeactivateSKU = async (uuid: string) => {
    if (!address) return;

    const signer = getOfflineSignerDirect();
    if (!signer) {
      setTxResult({ success: false, message: 'Failed to get signer' });
      return;
    }

    const result = await deactivateSKU(signer, address, uuid);
    if (result.success) {
      setTxResult({ success: true, message: `SKU deactivated! Tx: ${result.transactionHash?.slice(0, 16)}...` });
      setTimeout(fetchData, 1000);
    } else {
      setTxResult({ success: false, message: result.error || 'Failed to deactivate SKU' });
    }
  };

  const handleCreateProvider = async (params: { address: string; payoutAddress: string; apiUrl: string }) => {
    if (!address) return;

    const signer = getOfflineSignerDirect();
    if (!signer) {
      setTxResult({ success: false, message: 'Failed to get signer' });
      return;
    }

    const result = await createProvider(signer, address, params);
    if (result.success) {
      setTxResult({ success: true, message: `Provider created! Tx: ${result.transactionHash?.slice(0, 16)}...` });
      setShowCreateProvider(false);
      setTimeout(fetchData, 1000);
    } else {
      setTxResult({ success: false, message: result.error || 'Failed to create provider' });
    }
  };

  const handleUpdateProvider = async (params: { uuid: string; address: string; payoutAddress: string; apiUrl: string; active: boolean }) => {
    if (!address) return;

    const signer = getOfflineSignerDirect();
    if (!signer) {
      setTxResult({ success: false, message: 'Failed to get signer' });
      return;
    }

    const result = await updateProvider(signer, address, params);
    if (result.success) {
      setTxResult({ success: true, message: `Provider updated! Tx: ${result.transactionHash?.slice(0, 16)}...` });
      setEditingProvider(null);
      setTimeout(fetchData, 1000);
    } else {
      setTxResult({ success: false, message: result.error || 'Failed to update provider' });
    }
  };

  const handleCreateSKU = async (params: { providerUuid: string; name: string; unit: number; priceAmount: string; priceDenom: string }) => {
    if (!address) return;

    const signer = getOfflineSignerDirect();
    if (!signer) {
      setTxResult({ success: false, message: 'Failed to get signer' });
      return;
    }

    const result = await createSKU(signer, address, {
      providerUuid: params.providerUuid,
      name: params.name,
      unit: params.unit,
      basePrice: { denom: params.priceDenom, amount: params.priceAmount },
    });

    if (result.success) {
      setTxResult({ success: true, message: `SKU created! Tx: ${result.transactionHash?.slice(0, 16)}...` });
      setShowCreateSKU(false);
      setTimeout(fetchData, 1000);
    } else {
      setTxResult({ success: false, message: result.error || 'Failed to create SKU' });
    }
  };

  const handleUpdateSKU = async (params: { uuid: string; providerUuid: string; name: string; unit: number; priceAmount: string; priceDenom: string; active: boolean }) => {
    if (!address) return;

    const signer = getOfflineSignerDirect();
    if (!signer) {
      setTxResult({ success: false, message: 'Failed to get signer' });
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
      setTxResult({ success: true, message: `SKU updated! Tx: ${result.transactionHash?.slice(0, 16)}...` });
      setEditingSKU(null);
      setTimeout(fetchData, 1000);
    } else {
      setTxResult({ success: false, message: result.error || 'Failed to update SKU' });
    }
  };

  return (
    <div className="space-y-6">
      {/* Error Banner */}
      {error && (
        <div className="rounded-lg border border-red-700 bg-red-900/20 p-4 text-red-400">
          {error}
          <button onClick={fetchData} className="ml-4 underline hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {/* Transaction Result Banner */}
      {txResult && (
        <div
          className={`rounded-lg border p-4 ${
            txResult.success
              ? 'border-green-700 bg-green-900/20 text-green-400'
              : 'border-red-700 bg-red-900/20 text-red-400'
          }`}
        >
          {txResult.message}
          <button
            onClick={() => setTxResult(null)}
            className="ml-4 text-gray-400 hover:text-white"
          >
            ✕
          </button>
        </div>
      )}

      {/* SKU Module Access Banner */}
      {isConnected && (
        <div
          className={`rounded-lg border p-4 ${
            isInSKUAllowedList
              ? 'border-purple-700 bg-purple-900/20'
              : 'border-gray-700 bg-gray-800'
          }`}
        >
          <div className="flex items-center gap-3">
            {isInSKUAllowedList ? (
              <>
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-purple-600 text-xs text-white">
                  ✓
                </span>
                <div>
                  <div className="font-medium text-purple-300">SKU Module Admin</div>
                  <div className="text-sm text-gray-400">
                    Your wallet is in the SKU module allowed list. You can create and manage providers and SKUs.
                  </div>
                </div>
              </>
            ) : (
              <>
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-600 text-xs text-gray-400">
                  ○
                </span>
                <div>
                  <div className="font-medium text-gray-300">Read-Only Access</div>
                  <div className="text-sm text-gray-500">
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
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded border-gray-600 bg-gray-700"
            />
            Show inactive
          </label>
          <button
            onClick={fetchData}
            disabled={loading}
            className="rounded border border-gray-600 px-3 py-1 text-sm text-gray-400 hover:bg-gray-700 disabled:opacity-50"
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
        <div className="flex gap-2">
          {isConnected && isInSKUAllowedList && (
            <>
              <button
                onClick={() => setShowCreateProvider(true)}
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                + Create Provider
              </button>
              <button
                onClick={() => setShowCreateSKU(true)}
                disabled={providers.filter((p) => p.active).length === 0}
                className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                + Create SKU
              </button>
            </>
          )}
          {!isConnected && (
            <button
              onClick={onConnect}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Connect Wallet
            </button>
          )}
        </div>
      </div>

      {/* Providers Section */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Providers</h2>
        {loading && providers.length === 0 ? (
          <div className="text-gray-400">Loading providers...</div>
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
              <div className="text-sm text-gray-400">{providers.length} providers</div>
            </button>
            {providers.map((provider) => (
              <ProviderCard
                key={provider.uuid}
                provider={provider}
                isSelected={selectedProvider === provider.uuid}
                onSelect={() => setSelectedProvider(provider.uuid)}
                onEdit={isInSKUAllowedList ? () => setEditingProvider(provider) : undefined}
                onDeactivate={isInSKUAllowedList ? () => handleDeactivateProvider(provider.uuid) : undefined}
              />
            ))}
          </div>
        )}
      </div>

      {/* SKUs Section */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          SKUs {selectedProvider && `(${getProviderName(selectedProvider)})`}
        </h2>
        {loading && skus.length === 0 ? (
          <div className="text-gray-400">Loading SKUs...</div>
        ) : skus.length === 0 ? (
          <p className="text-gray-400">No SKUs found</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-700 text-left text-sm text-gray-400">
                  <th className="pb-3 pr-4">Name</th>
                  <th className="pb-3 pr-4">Provider</th>
                  <th className="pb-3 pr-4">Price</th>
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
      {showCreateProvider && (
        <Modal title="Create Provider" onClose={() => setShowCreateProvider(false)}>
          <CreateProviderForm
            defaultAddress={address}
            onSubmit={handleCreateProvider}
            onClose={() => setShowCreateProvider(false)}
          />
        </Modal>
      )}

      {/* Create SKU Modal */}
      {showCreateSKU && (
        <Modal title="Create SKU" onClose={() => setShowCreateSKU(false)}>
          <CreateSKUForm
            providers={providers}
            onSubmit={handleCreateSKU}
            onClose={() => setShowCreateSKU(false)}
          />
        </Modal>
      )}

      {/* Edit Provider Modal */}
      {editingProvider && (
        <Modal title="Edit Provider" onClose={() => setEditingProvider(null)}>
          <EditProviderForm
            provider={editingProvider}
            onSubmit={handleUpdateProvider}
            onClose={() => setEditingProvider(null)}
          />
        </Modal>
      )}

      {/* Edit SKU Modal */}
      {editingSKU && (
        <Modal title="Edit SKU" onClose={() => setEditingSKU(null)}>
          <EditSKUForm
            sku={editingSKU}
            providers={providers}
            onSubmit={handleUpdateSKU}
            onClose={() => setEditingSKU(null)}
          />
        </Modal>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  isSelected,
  onSelect,
  onEdit,
  onDeactivate,
}: {
  provider: Provider;
  isSelected: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onDeactivate?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopyUuid = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const success = await copyToClipboard(provider.uuid);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
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
          <div className="font-medium text-white" title={provider.address}>
            {formatAddress(provider.address)}
          </div>
          {!provider.active && (
            <span className="rounded bg-gray-600 px-2 py-0.5 text-xs text-gray-300">Inactive</span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-1">
          <button
            onClick={handleCopyUuid}
            className="font-mono text-xs text-gray-500 hover:text-gray-300"
            title={`Click to copy: ${provider.uuid}`}
          >
            {provider.uuid.slice(0, 8)}...
            <span className="ml-1 text-gray-600">{copied ? '(copied!)' : '(copy)'}</span>
          </button>
        </div>
        <div className="mt-2 truncate text-xs text-gray-500">{provider.api_url || 'No API URL'}</div>
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
  onEdit,
  onDeactivate,
}: {
  sku: SKU;
  providerName: string;
  formatPrice: (amount: string, denom: string, unit: string) => string;
  onEdit?: () => void;
  onDeactivate?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopyUuid = async () => {
    const success = await copyToClipboard(sku.uuid);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <tr className="border-b border-gray-700/50">
      <td className="py-3 pr-4">
        <div className="font-medium text-white">{sku.name}</div>
        <button
          onClick={handleCopyUuid}
          className="font-mono text-xs text-gray-500 hover:text-gray-300"
          title={`Click to copy: ${sku.uuid}`}
        >
          {sku.uuid.slice(0, 8)}...
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
        {sku.active ? (
          <span className="rounded bg-green-900/50 px-2 py-1 text-xs text-green-400">Active</span>
        ) : (
          <span className="rounded bg-gray-700 px-2 py-1 text-xs text-gray-400">Inactive</span>
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

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-800 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
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
        <label className="mb-1 block text-sm text-gray-400">Management Address</label>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="manifest1..."
          required
          className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm text-gray-400">Payout Address</label>
        <input
          type="text"
          value={payoutAddress}
          onChange={(e) => setPayoutAddress(e.target.value)}
          placeholder="manifest1..."
          required
          className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm text-gray-400">API URL</label>
        <input
          type="url"
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          placeholder="https://..."
          className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white">
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !address || !payoutAddress}
          className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
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
        <label className="mb-1 block text-sm text-gray-400">Provider</label>
        <select
          value={providerUuid}
          onChange={(e) => setProviderUuid(e.target.value)}
          required
          className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
        >
          {activeProviders.map((p) => (
            <option key={p.uuid} value={p.uuid}>
              {formatAddress(p.address)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-sm text-gray-400">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Small VM"
          required
          className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm text-gray-400">Price (uPWR)</label>
          <input
            type="number"
            value={priceAmount}
            onChange={(e) => setPriceAmount(e.target.value)}
            placeholder="1000000"
            required
            className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-gray-400">Unit</label>
          <select
            value={unit}
            onChange={(e) => setUnit(Number(e.target.value))}
            className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
          >
            <option value={Unit.UNIT_PER_HOUR}>Per Hour</option>
            <option value={Unit.UNIT_PER_DAY}>Per Day</option>
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white">
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !providerUuid || !name || !priceAmount}
          className="rounded bg-green-600 px-4 py-2 font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
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
      <div className="rounded bg-gray-700/50 p-3 text-xs text-gray-400">
        <span className="text-gray-500">UUID: </span>
        <span className="font-mono">{provider.uuid}</span>
      </div>
      <div>
        <label className="mb-1 block text-sm text-gray-400">Management Address</label>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="manifest1..."
          required
          className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm text-gray-400">Payout Address</label>
        <input
          type="text"
          value={payoutAddress}
          onChange={(e) => setPayoutAddress(e.target.value)}
          placeholder="manifest1..."
          required
          className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm text-gray-400">API URL</label>
        <input
          type="url"
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          placeholder="https://..."
          className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div>
        <label className="flex items-center gap-2 text-sm text-gray-400">
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
        <button type="button" onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white">
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !address || !payoutAddress}
          className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
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
  const [unit, setUnit] = useState<number>(sku.unit === 'UNIT_PER_HOUR' ? Unit.UNIT_PER_HOUR : sku.unit === 'UNIT_PER_DAY' ? Unit.UNIT_PER_DAY : Unit.UNIT_UNSPECIFIED);
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
      <div className="rounded bg-gray-700/50 p-3 text-xs text-gray-400">
        <span className="text-gray-500">UUID: </span>
        <span className="font-mono">{sku.uuid}</span>
      </div>
      <div>
        <label className="mb-1 block text-sm text-gray-400">Provider</label>
        <select
          value={providerUuid}
          onChange={(e) => setProviderUuid(e.target.value)}
          required
          className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
        >
          {providers.map((p) => (
            <option key={p.uuid} value={p.uuid}>
              {formatAddress(p.address)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-sm text-gray-400">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Small VM"
          required
          className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm text-gray-400">Price (uPWR)</label>
          <input
            type="number"
            value={priceAmount}
            onChange={(e) => setPriceAmount(e.target.value)}
            placeholder="1000000"
            required
            className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-gray-400">Unit</label>
          <select
            value={unit}
            onChange={(e) => setUnit(Number(e.target.value))}
            className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
          >
            <option value={Unit.UNIT_PER_HOUR}>Per Hour</option>
            <option value={Unit.UNIT_PER_DAY}>Per Day</option>
          </select>
        </div>
      </div>
      <div>
        <label className="flex items-center gap-2 text-sm text-gray-400">
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
        <button type="button" onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white">
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !providerUuid || !name || !priceAmount}
          className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Updating...' : 'Update SKU'}
        </button>
      </div>
    </form>
  );
}
