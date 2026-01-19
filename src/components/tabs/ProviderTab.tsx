import { useState } from 'react';
import { mockLeases, mockSKUs, mockProviders } from '../../mockData';
import type { Lease } from '../../types';

// Simulating that we're provider 1
const myProviderUuid = '0194d8a0-0001-7000-8000-000000000001';

export function ProviderTab() {
  const myProvider = mockProviders.find((p) => p.uuid === myProviderUuid);
  const providerLeases = mockLeases.filter((l) => l.providerUuid === myProviderUuid);

  const pendingLeases = providerLeases.filter((l) => l.state === 'LEASE_STATE_PENDING');
  const activeLeases = providerLeases.filter((l) => l.state === 'LEASE_STATE_ACTIVE');

  const calculateWithdrawable = () => {
    // Mock calculation: sum of all active leases' accrued amounts
    let total = 0;
    for (const lease of activeLeases) {
      for (const item of lease.items) {
        const perSecond = parseInt(item.lockedPrice.amount, 10);
        const seconds = lease.lastSettledAt
          ? (Date.now() - new Date(lease.lastSettledAt).getTime()) / 1000
          : 0;
        total += perSecond * item.quantity * seconds;
      }
    }
    return (total / 1_000_000).toFixed(4);
  };

  if (!myProvider) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="mb-6 text-6xl">🏢</div>
        <h2 className="mb-4 text-2xl font-semibold text-white">No Provider Found</h2>
        <p className="text-gray-400">
          Your connected address is not associated with any provider.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Provider Info Card */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="mb-2 text-lg font-semibold text-white">Your Provider</h2>
            <div className="space-y-1 text-sm">
              <div>
                <span className="text-gray-400">UUID: </span>
                <span className="font-mono text-gray-300">{myProvider.uuid}</span>
              </div>
              <div>
                <span className="text-gray-400">Address: </span>
                <span className="font-mono text-gray-300">{myProvider.address}</span>
              </div>
              <div>
                <span className="text-gray-400">Payout: </span>
                <span className="font-mono text-gray-300">{myProvider.payoutAddress}</span>
              </div>
              <div>
                <span className="text-gray-400">API: </span>
                <span className="text-blue-400">{myProvider.apiUrl}</span>
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm text-gray-400">Withdrawable</div>
            <div className="text-2xl font-bold text-green-400">{calculateWithdrawable()} MFX</div>
            <button
              onClick={() => alert('Would withdraw all funds')}
              className="mt-2 rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
              Withdraw All
            </button>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-700 bg-gray-800 p-4">
          <div className="text-2xl font-bold text-yellow-400">{pendingLeases.length}</div>
          <div className="text-sm text-gray-400">Pending Approval</div>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-800 p-4">
          <div className="text-2xl font-bold text-green-400">{activeLeases.length}</div>
          <div className="text-sm text-gray-400">Active Leases</div>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-800 p-4">
          <div className="text-2xl font-bold text-blue-400">
            {mockSKUs.filter((s) => s.providerUuid === myProviderUuid && s.active).length}
          </div>
          <div className="text-sm text-gray-400">Active SKUs</div>
        </div>
      </div>

      {/* Pending Leases */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          Pending Leases
          {pendingLeases.length > 0 && (
            <span className="ml-2 rounded-full bg-yellow-600 px-2 py-0.5 text-xs">
              {pendingLeases.length}
            </span>
          )}
        </h2>
        {pendingLeases.length === 0 ? (
          <p className="text-gray-400">No pending leases to review</p>
        ) : (
          <div className="space-y-3">
            {pendingLeases.map((lease) => (
              <PendingLeaseCard key={lease.uuid} lease={lease} />
            ))}
          </div>
        )}
      </div>

      {/* Active Leases */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Active Leases</h2>
        {activeLeases.length === 0 ? (
          <p className="text-gray-400">No active leases</p>
        ) : (
          <div className="space-y-3">
            {activeLeases.map((lease) => (
              <ActiveLeaseCard key={lease.uuid} lease={lease} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PendingLeaseCard({ lease }: { lease: Lease }) {
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);

  const getSKUName = (uuid: string) => {
    const sku = mockSKUs.find((s) => s.uuid === uuid);
    return sku?.name || 'Unknown SKU';
  };

  return (
    <div className="rounded-lg border border-yellow-600/30 bg-yellow-900/10 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono text-sm text-gray-300">{lease.uuid.slice(0, 20)}...</div>
          <div className="mt-1 text-sm text-gray-400">
            Tenant: <span className="font-mono">{lease.tenant.slice(0, 20)}...</span>
          </div>
          <div className="text-xs text-gray-500">
            Created: {new Date(lease.createdAt).toLocaleString()}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => alert(`Would acknowledge lease: ${lease.uuid}`)}
            className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
          >
            Acknowledge
          </button>
          <button
            onClick={() => setShowRejectForm(!showRejectForm)}
            className="rounded border border-red-600 px-4 py-2 text-sm text-red-400 hover:bg-red-900/20"
          >
            Reject
          </button>
        </div>
      </div>

      {/* Items */}
      <div className="mb-3 rounded bg-gray-800/50 p-2">
        <div className="text-xs font-medium uppercase text-gray-500">Requested Items</div>
        {lease.items.map((item, idx) => (
          <div key={idx} className="mt-1 flex justify-between text-sm">
            <span className="text-white">
              {getSKUName(item.skuUuid)} × {item.quantity}
            </span>
            <span className="text-gray-400">
              {(parseInt(item.lockedPrice.amount, 10) / 1_000_000 * 3600).toFixed(4)} MFX/hr
            </span>
          </div>
        ))}
      </div>

      {/* Reject Form */}
      {showRejectForm && (
        <div className="mt-3 border-t border-gray-700 pt-3">
          <label className="mb-1 block text-sm text-gray-400">Rejection Reason (optional)</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g., Insufficient capacity"
              maxLength={256}
              className="flex-1 rounded border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-red-500 focus:outline-none"
            />
            <button
              onClick={() => alert(`Would reject lease: ${lease.uuid}\nReason: ${rejectReason || 'None'}`)}
              className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              Confirm Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ActiveLeaseCard({ lease }: { lease: Lease }) {
  const getSKUName = (uuid: string) => {
    const sku = mockSKUs.find((s) => s.uuid === uuid);
    return sku?.name || 'Unknown SKU';
  };

  // Calculate mock withdrawable amount
  const calculateLeaseWithdrawable = () => {
    let total = 0;
    for (const item of lease.items) {
      const perSecond = parseInt(item.lockedPrice.amount, 10);
      const seconds = lease.lastSettledAt
        ? (Date.now() - new Date(lease.lastSettledAt).getTime()) / 1000
        : 0;
      total += perSecond * item.quantity * seconds;
    }
    return (total / 1_000_000).toFixed(4);
  };

  const hourlyRate = () => {
    let total = 0;
    for (const item of lease.items) {
      const perSecond = parseInt(item.lockedPrice.amount, 10);
      total += perSecond * item.quantity * 3600;
    }
    return (total / 1_000_000).toFixed(4);
  };

  return (
    <div className="rounded-lg border border-green-600/30 bg-green-900/10 p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono text-sm text-gray-300">{lease.uuid.slice(0, 20)}...</div>
          <div className="mt-1 text-sm text-gray-400">
            Tenant: <span className="font-mono">{lease.tenant.slice(0, 20)}...</span>
          </div>
          <div className="text-xs text-gray-500">
            Active since: {lease.acknowledgedAt ? new Date(lease.acknowledgedAt).toLocaleString() : '-'}
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm text-gray-400">Withdrawable</div>
          <div className="font-bold text-green-400">{calculateLeaseWithdrawable()} MFX</div>
          <div className="text-xs text-gray-500">@ {hourlyRate()} MFX/hr</div>
        </div>
      </div>

      {/* Items */}
      <div className="mt-3 rounded bg-gray-800/50 p-2">
        {lease.items.map((item, idx) => (
          <div key={idx} className="flex justify-between text-sm">
            <span className="text-white">
              {getSKUName(item.skuUuid)} × {item.quantity}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          onClick={() => alert(`Would withdraw from lease: ${lease.uuid}`)}
          className="rounded border border-green-600 px-3 py-1 text-sm text-green-400 hover:bg-green-900/20"
        >
          Withdraw
        </button>
        <button
          onClick={() => alert(`Would close lease: ${lease.uuid}`)}
          className="rounded border border-orange-600 px-3 py-1 text-sm text-orange-400 hover:bg-orange-900/20"
        >
          Close Lease
        </button>
      </div>
    </div>
  );
}
