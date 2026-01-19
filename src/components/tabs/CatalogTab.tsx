import { useState } from 'react';
import { mockProviders, mockSKUs } from '../../mockData';
import type { Provider, SKU } from '../../types';

export function CatalogTab() {
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [showCreateProvider, setShowCreateProvider] = useState(false);
  const [showCreateSKU, setShowCreateSKU] = useState(false);

  const filteredProviders = showInactive
    ? mockProviders
    : mockProviders.filter((p) => p.active);

  const filteredSKUs = mockSKUs.filter((sku) => {
    if (selectedProvider && sku.providerUuid !== selectedProvider) return false;
    if (!showInactive && !sku.active) return false;
    return true;
  });

  const getProviderName = (uuid: string) => {
    const provider = mockProviders.find((p) => p.uuid === uuid);
    return provider?.address.slice(0, 20) + '...' || 'Unknown';
  };

  const formatPrice = (amount: string, denom: string, unit: string) => {
    const num = parseInt(amount, 10) / 1_000_000;
    const unitLabel = unit === 'UNIT_PER_HOUR' ? '/hr' : '/day';
    return `${num} ${denom.replace('u', '').toUpperCase()}${unitLabel}`;
  };

  return (
    <div className="space-y-6">
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
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCreateProvider(true)}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            + Create Provider
          </button>
          <button
            onClick={() => setShowCreateSKU(true)}
            className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
          >
            + Create SKU
          </button>
        </div>
      </div>

      {/* Providers Section */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Providers</h2>
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
            <div className="text-sm text-gray-400">{mockSKUs.length} SKUs total</div>
          </button>
          {filteredProviders.map((provider) => (
            <ProviderCard
              key={provider.uuid}
              provider={provider}
              skuCount={mockSKUs.filter((s) => s.providerUuid === provider.uuid).length}
              isSelected={selectedProvider === provider.uuid}
              onSelect={() => setSelectedProvider(provider.uuid)}
            />
          ))}
        </div>
      </div>

      {/* SKUs Section */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          SKUs {selectedProvider && `(${getProviderName(selectedProvider)})`}
        </h2>
        {filteredSKUs.length === 0 ? (
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
                {filteredSKUs.map((sku) => (
                  <SKURow key={sku.uuid} sku={sku} providerName={getProviderName(sku.providerUuid)} formatPrice={formatPrice} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Provider Modal */}
      {showCreateProvider && (
        <Modal title="Create Provider" onClose={() => setShowCreateProvider(false)}>
          <CreateProviderForm onClose={() => setShowCreateProvider(false)} />
        </Modal>
      )}

      {/* Create SKU Modal */}
      {showCreateSKU && (
        <Modal title="Create SKU" onClose={() => setShowCreateSKU(false)}>
          <CreateSKUForm providers={mockProviders} onClose={() => setShowCreateSKU(false)} />
        </Modal>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  skuCount,
  isSelected,
  onSelect,
}: {
  provider: Provider;
  skuCount: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`rounded-lg border p-4 text-left transition-colors ${
        isSelected
          ? 'border-blue-500 bg-blue-500/10'
          : 'border-gray-600 hover:border-gray-500'
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="font-medium text-white">{provider.address.slice(0, 16)}...</div>
        {!provider.active && (
          <span className="rounded bg-gray-600 px-2 py-0.5 text-xs text-gray-300">Inactive</span>
        )}
      </div>
      <div className="mt-1 text-sm text-gray-400">{skuCount} SKUs</div>
      <div className="mt-2 truncate text-xs text-gray-500">{provider.apiUrl}</div>
    </button>
  );
}

function SKURow({
  sku,
  providerName,
  formatPrice,
}: {
  sku: SKU;
  providerName: string;
  formatPrice: (amount: string, denom: string, unit: string) => string;
}) {
  return (
    <tr className="border-b border-gray-700/50">
      <td className="py-3 pr-4">
        <div className="font-medium text-white">{sku.name}</div>
        <div className="font-mono text-xs text-gray-500">{sku.uuid.slice(0, 8)}...</div>
      </td>
      <td className="py-3 pr-4 text-sm text-gray-300">{providerName}</td>
      <td className="py-3 pr-4">
        <span className="font-medium text-green-400">
          {formatPrice(sku.basePrice.amount, sku.basePrice.denom, sku.unit)}
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
        <button
          onClick={() => alert(`Would deactivate SKU: ${sku.uuid}`)}
          className="text-sm text-red-400 hover:text-red-300"
        >
          Deactivate
        </button>
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

function CreateProviderForm({ onClose }: { onClose: () => void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        alert('Would create provider');
        onClose();
      }}
      className="space-y-4"
    >
      <div>
        <label className="mb-1 block text-sm text-gray-400">Management Address</label>
        <input
          type="text"
          placeholder="manifest1..."
          className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm text-gray-400">Payout Address</label>
        <input
          type="text"
          placeholder="manifest1..."
          className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm text-gray-400">API URL</label>
        <input
          type="url"
          placeholder="https://..."
          className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white">
          Cancel
        </button>
        <button type="submit" className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700">
          Create Provider
        </button>
      </div>
    </form>
  );
}

function CreateSKUForm({ providers, onClose }: { providers: Provider[]; onClose: () => void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        alert('Would create SKU');
        onClose();
      }}
      className="space-y-4"
    >
      <div>
        <label className="mb-1 block text-sm text-gray-400">Provider</label>
        <select className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none">
          {providers.filter((p) => p.active).map((p) => (
            <option key={p.uuid} value={p.uuid}>
              {p.address.slice(0, 20)}...
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-sm text-gray-400">Name</label>
        <input
          type="text"
          placeholder="e.g., Small VM"
          className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm text-gray-400">Price (umfx)</label>
          <input
            type="number"
            placeholder="1000"
            className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-gray-400">Unit</label>
          <select className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none">
            <option value="UNIT_PER_HOUR">Per Hour</option>
            <option value="UNIT_PER_DAY">Per Day</option>
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white">
          Cancel
        </button>
        <button type="submit" className="rounded bg-green-600 px-4 py-2 font-medium text-white hover:bg-green-700">
          Create SKU
        </button>
      </div>
    </form>
  );
}
