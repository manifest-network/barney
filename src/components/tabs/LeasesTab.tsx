import { useState } from 'react';
import { mockLeases, mockSKUs, mockProviders } from '../../mockData';
import type { Lease, LeaseState, SKU } from '../../types';

const tenantAddress = 'manifest1tenantaddress';

const stateColors: Record<LeaseState, { bg: string; text: string }> = {
  LEASE_STATE_PENDING: { bg: 'bg-yellow-900/50', text: 'text-yellow-400' },
  LEASE_STATE_ACTIVE: { bg: 'bg-green-900/50', text: 'text-green-400' },
  LEASE_STATE_CLOSED: { bg: 'bg-gray-700', text: 'text-gray-400' },
  LEASE_STATE_REJECTED: { bg: 'bg-red-900/50', text: 'text-red-400' },
  LEASE_STATE_EXPIRED: { bg: 'bg-gray-700', text: 'text-gray-500' },
};

const stateLabels: Record<LeaseState, string> = {
  LEASE_STATE_PENDING: 'Pending',
  LEASE_STATE_ACTIVE: 'Active',
  LEASE_STATE_CLOSED: 'Closed',
  LEASE_STATE_REJECTED: 'Rejected',
  LEASE_STATE_EXPIRED: 'Expired',
};

export function LeasesTab() {
  const [stateFilter, setStateFilter] = useState<LeaseState | 'all'>('all');
  const [showCreateLease, setShowCreateLease] = useState(false);

  const myLeases = mockLeases.filter((l) => l.tenant === tenantAddress);
  const filteredLeases =
    stateFilter === 'all' ? myLeases : myLeases.filter((l) => l.state === stateFilter);

  const getSKU = (uuid: string) => mockSKUs.find((s) => s.uuid === uuid);
  const getProvider = (uuid: string) => mockProviders.find((p) => p.uuid === uuid);

  return (
    <div className="space-y-6">
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
        </div>
        <button
          onClick={() => setShowCreateLease(true)}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          + Create Lease
        </button>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-4">
        {(['LEASE_STATE_PENDING', 'LEASE_STATE_ACTIVE', 'LEASE_STATE_CLOSED', 'LEASE_STATE_REJECTED'] as LeaseState[]).map(
          (state) => {
            const count = myLeases.filter((l) => l.state === state).length;
            return (
              <div
                key={state}
                className="rounded-lg border border-gray-700 bg-gray-800 p-4"
              >
                <div className="text-2xl font-bold text-white">{count}</div>
                <div className={`text-sm ${stateColors[state].text}`}>
                  {stateLabels[state]}
                </div>
              </div>
            );
          }
        )}
      </div>

      {/* Leases List */}
      <div className="space-y-4">
        {filteredLeases.length === 0 ? (
          <div className="rounded-lg border border-gray-700 bg-gray-800 p-8 text-center">
            <p className="text-gray-400">No leases found</p>
            <button
              onClick={() => setShowCreateLease(true)}
              className="mt-4 text-blue-400 hover:text-blue-300"
            >
              Create your first lease
            </button>
          </div>
        ) : (
          filteredLeases.map((lease) => (
            <LeaseCard
              key={lease.uuid}
              lease={lease}
              getSKU={getSKU}
              getProvider={getProvider}
            />
          ))
        )}
      </div>

      {/* Create Lease Modal */}
      {showCreateLease && (
        <CreateLeaseModal onClose={() => setShowCreateLease(false)} />
      )}
    </div>
  );
}

function LeaseCard({
  lease,
  getSKU,
  getProvider,
}: {
  lease: Lease;
  getSKU: (uuid: string) => SKU | undefined;
  getProvider: (uuid: string) => typeof mockProviders[0] | undefined;
}) {
  const provider = getProvider(lease.providerUuid);
  const colors = stateColors[lease.state];

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString();
  };

  const calculateTotalPerHour = () => {
    let total = 0;
    for (const item of lease.items) {
      const perSecond = parseInt(item.lockedPrice.amount, 10);
      total += perSecond * item.quantity * 3600;
    }
    return (total / 1_000_000).toFixed(4);
  };

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-gray-400">{lease.uuid.slice(0, 16)}...</span>
            <span className={`rounded px-2 py-0.5 text-xs ${colors.bg} ${colors.text}`}>
              {stateLabels[lease.state]}
            </span>
          </div>
          <div className="mt-1 text-sm text-gray-500">
            Provider: {provider?.address.slice(0, 20) || 'Unknown'}...
          </div>
        </div>
        <div className="flex gap-2">
          {lease.state === 'LEASE_STATE_PENDING' && (
            <button
              onClick={() => alert(`Would cancel lease: ${lease.uuid}`)}
              className="rounded border border-red-600 px-3 py-1 text-sm text-red-400 hover:bg-red-900/20"
            >
              Cancel
            </button>
          )}
          {lease.state === 'LEASE_STATE_ACTIVE' && (
            <button
              onClick={() => alert(`Would close lease: ${lease.uuid}`)}
              className="rounded border border-orange-600 px-3 py-1 text-sm text-orange-400 hover:bg-orange-900/20"
            >
              Close
            </button>
          )}
        </div>
      </div>

      {/* Lease Items */}
      <div className="mb-4 rounded bg-gray-700/30 p-3">
        <div className="mb-2 text-xs font-medium uppercase text-gray-500">Items</div>
        <div className="space-y-2">
          {lease.items.map((item, idx) => {
            const sku = getSKU(item.skuUuid);
            return (
              <div key={idx} className="flex items-center justify-between text-sm">
                <span className="text-white">
                  {sku?.name || 'Unknown SKU'} × {item.quantity}
                </span>
                <span className="text-gray-400">
                  {(parseInt(item.lockedPrice.amount, 10) / 1_000_000 * 3600).toFixed(4)} MFX/hr each
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-3 border-t border-gray-600 pt-2 text-right">
          <span className="text-sm text-gray-400">Total: </span>
          <span className="font-medium text-green-400">{calculateTotalPerHour()} MFX/hr</span>
        </div>
      </div>

      {/* Timestamps */}
      <div className="grid gap-2 text-xs text-gray-500 sm:grid-cols-2">
        <div>Created: {formatDate(lease.createdAt)}</div>
        {lease.acknowledgedAt && <div>Acknowledged: {formatDate(lease.acknowledgedAt)}</div>}
        {lease.closedAt && <div>Closed: {formatDate(lease.closedAt)}</div>}
        {lease.rejectedAt && (
          <div className="text-red-400">
            Rejected: {formatDate(lease.rejectedAt)}
            {lease.rejectionReason && ` - ${lease.rejectionReason}`}
          </div>
        )}
      </div>
    </div>
  );
}

function CreateLeaseModal({ onClose }: { onClose: () => void }) {
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [items, setItems] = useState<{ skuUuid: string; quantity: number }[]>([
    { skuUuid: '', quantity: 1 },
  ]);

  const activeProviders = mockProviders.filter((p) => p.active);
  const providerSKUs = selectedProvider
    ? mockSKUs.filter((s) => s.providerUuid === selectedProvider && s.active)
    : [];

  const addItem = () => setItems([...items, { skuUuid: '', quantity: 1 }]);
  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));
  const updateItem = (idx: number, field: 'skuUuid' | 'quantity', value: string | number) => {
    setItems(items.map((item, i) => (i === idx ? { ...item, [field]: value } : item)));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg border border-gray-700 bg-gray-800 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">Create Lease</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            ✕
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            alert(`Would create lease with ${items.length} item(s)`);
            onClose();
          }}
          className="space-y-4"
        >
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
            >
              <option value="">Select a provider...</option>
              {activeProviders.map((p) => (
                <option key={p.uuid} value={p.uuid}>
                  {p.address.slice(0, 24)}...
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
                >
                  + Add Item
                </button>
              </div>
              <div className="space-y-3">
                {items.map((item, idx) => (
                  <div key={idx} className="flex gap-2">
                    <select
                      value={item.skuUuid}
                      onChange={(e) => updateItem(idx, 'skuUuid', e.target.value)}
                      className="flex-1 rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                      required
                    >
                      <option value="">Select SKU...</option>
                      {providerSKUs.map((sku) => (
                        <option key={sku.uuid} value={sku.uuid}>
                          {sku.name} ({(parseInt(sku.basePrice.amount, 10) / 1_000_000).toFixed(4)} MFX/
                          {sku.unit === 'UNIT_PER_HOUR' ? 'hr' : 'day'})
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) => updateItem(idx, 'quantity', parseInt(e.target.value, 10) || 1)}
                      className="w-20 rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                    />
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeItem(idx)}
                        className="px-2 text-red-400 hover:text-red-300"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!selectedProvider || items.some((i) => !i.skuUuid)}
              className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Create Lease
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
