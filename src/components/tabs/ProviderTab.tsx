import { useState, useEffect, useCallback } from 'react';
import { useChain } from '@cosmos-kit/react';
import type { Lease } from '../../api/billing';
import { getLeasesByProvider, getWithdrawableAmount, getBillingParams } from '../../api/billing';
import { getProviders, getSKUsByProvider, type Provider, type SKU } from '../../api/sku';
import { acknowledgeLease, rejectLease, withdrawFromLeases, closeLease, type TxResult } from '../../api/tx';
import { DENOM_METADATA, formatPrice } from '../../api/config';
import type { Coin } from '../../api/bank';

const CHAIN_NAME = 'manifestlocal';

function formatAddress(addr: string): string {
  if (!addr || addr.length < 20) return addr;
  const prefix = addr.slice(0, 9);
  const start = addr.slice(9, 13);
  const end = addr.slice(-4);
  return `${prefix}${start}...${end}`;
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
}

export function ProviderTab() {
  const { address, isWalletConnected, openView, getOfflineSigner } = useChain(CHAIN_NAME);

  const [myProvider, setMyProvider] = useState<Provider | null>(null);
  const [providerLeases, setProviderLeases] = useState<Lease[]>([]);
  const [providerSKUs, setProviderSKUs] = useState<SKU[]>([]);
  const [withdrawableAmounts, setWithdrawableAmounts] = useState<Map<string, Coin[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInBillingAllowedList, setIsInBillingAllowedList] = useState(false);
  const [txStatus, setTxStatus] = useState<{ loading: boolean; message: string } | null>(null);

  const fetchData = useCallback(async () => {
    if (!address) {
      setMyProvider(null);
      setProviderLeases([]);
      setProviderSKUs([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Get all providers and find ours
      const [providers, billingParams] = await Promise.all([
        getProviders(),
        getBillingParams(),
      ]);

      const myProv = providers.find((p) => p.address === address);
      setMyProvider(myProv || null);
      setIsInBillingAllowedList(billingParams.allowed_list.includes(address));

      if (myProv) {
        // Fetch leases and SKUs for this provider
        const [leases, skus] = await Promise.all([
          getLeasesByProvider(myProv.uuid),
          getSKUsByProvider(myProv.uuid),
        ]);

        setProviderLeases(leases);
        setProviderSKUs(skus);

        // Fetch withdrawable amounts for active leases
        const activeLeases = leases.filter((l) => l.state === 'LEASE_STATE_ACTIVE');
        const withdrawableMap = new Map<string, Coin[]>();

        await Promise.all(
          activeLeases.map(async (lease) => {
            try {
              const amounts = await getWithdrawableAmount(lease.uuid);
              withdrawableMap.set(lease.uuid, amounts);
            } catch {
              // Ignore errors for individual lease queries
            }
          })
        );

        setWithdrawableAmounts(withdrawableMap);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const pendingLeases = providerLeases.filter((l) => l.state === 'LEASE_STATE_PENDING');
  const activeLeases = providerLeases.filter((l) => l.state === 'LEASE_STATE_ACTIVE');

  const calculateTotalWithdrawable = (): Coin[] => {
    const totals = new Map<string, bigint>();

    for (const amounts of withdrawableAmounts.values()) {
      for (const coin of amounts) {
        const current = totals.get(coin.denom) || BigInt(0);
        totals.set(coin.denom, current + BigInt(coin.amount));
      }
    }

    return Array.from(totals.entries()).map(([denom, amount]) => ({
      denom,
      amount: amount.toString(),
    }));
  };

  const handleAcknowledge = async (leaseUuid: string) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxStatus({ loading: true, message: 'Acknowledging lease...' });

      const result: TxResult = await acknowledgeLease(signer, address, [leaseUuid]);

      if (result.success) {
        setTxStatus({ loading: false, message: `Lease acknowledged! Tx: ${result.transactionHash}` });
        await fetchData();
      } else {
        setTxStatus({ loading: false, message: `Failed: ${result.error}` });
      }
    } catch (err) {
      setTxStatus({ loading: false, message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` });
    }
  };

  const handleReject = async (leaseUuid: string, reason: string) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxStatus({ loading: true, message: 'Rejecting lease...' });

      const result: TxResult = await rejectLease(signer, address, [leaseUuid], reason);

      if (result.success) {
        setTxStatus({ loading: false, message: `Lease rejected! Tx: ${result.transactionHash}` });
        await fetchData();
      } else {
        setTxStatus({ loading: false, message: `Failed: ${result.error}` });
      }
    } catch (err) {
      setTxStatus({ loading: false, message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` });
    }
  };

  const handleWithdraw = async (leaseUuids: string[]) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxStatus({ loading: true, message: 'Withdrawing funds...' });

      const result: TxResult = await withdrawFromLeases(signer, address, leaseUuids);

      if (result.success) {
        setTxStatus({ loading: false, message: `Withdrawal successful! Tx: ${result.transactionHash}` });
        await fetchData();
      } else {
        setTxStatus({ loading: false, message: `Failed: ${result.error}` });
      }
    } catch (err) {
      setTxStatus({ loading: false, message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` });
    }
  };

  const handleCloseLease = async (leaseUuid: string) => {
    if (!address) return;

    try {
      const signer = getOfflineSigner();
      setTxStatus({ loading: true, message: 'Closing lease...' });

      const result: TxResult = await closeLease(signer, address, [leaseUuid]);

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

  const getSKU = (uuid: string) => providerSKUs.find((s) => s.uuid === uuid);

  if (!isWalletConnected) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-8 text-center">
        <p className="mb-4 text-gray-400">Connect your wallet to view your provider dashboard</p>
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
        <div className="text-gray-400">Loading provider data...</div>
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

  if (!myProvider) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="mb-6 text-6xl">🏢</div>
        <h2 className="mb-4 text-2xl font-semibold text-white">No Provider Found</h2>
        <p className="text-gray-400">
          Your connected address is not associated with any provider.
        </p>
        <p className="mt-2 text-sm text-gray-500">
          Connected as: <span className="font-mono">{formatAddress(address || '')}</span>
        </p>
      </div>
    );
  }

  const totalWithdrawable = calculateTotalWithdrawable();

  return (
    <div className="space-y-6">
      {/* Billing Module Status */}
      {isInBillingAllowedList && (
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

      {/* Provider Info Card */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="mb-2 text-lg font-semibold text-white">Your Provider</h2>
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-gray-400">UUID:</span>
                <span className="font-mono text-gray-300">{myProvider.uuid}</span>
                <button
                  onClick={() => copyToClipboard(myProvider.uuid)}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  Copy
                </button>
              </div>
              <div>
                <span className="text-gray-400">Address: </span>
                <span className="font-mono text-gray-300">{formatAddress(myProvider.address)}</span>
              </div>
              <div>
                <span className="text-gray-400">Payout: </span>
                <span className="font-mono text-gray-300">{formatAddress(myProvider.payout_address)}</span>
              </div>
              <div>
                <span className="text-gray-400">API: </span>
                <span className="text-blue-400">{myProvider.api_url}</span>
              </div>
              <div>
                <span className="text-gray-400">Status: </span>
                <span className={myProvider.active ? 'text-green-400' : 'text-red-400'}>
                  {myProvider.active ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm text-gray-400">Total Withdrawable</div>
            {totalWithdrawable.length === 0 ? (
              <div className="text-2xl font-bold text-gray-500">0</div>
            ) : (
              totalWithdrawable.map((coin, idx) => (
                <div key={idx} className="text-2xl font-bold text-green-400">
                  {formatPrice(coin.amount, coin.denom)}
                </div>
              ))
            )}
            {activeLeases.length > 0 && totalWithdrawable.length > 0 && (
              <button
                onClick={() => handleWithdraw(activeLeases.map((l) => l.uuid))}
                disabled={txStatus?.loading}
                className="mt-2 rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Withdraw All
              </button>
            )}
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
            {providerSKUs.filter((s) => s.active).length}
          </div>
          <div className="text-sm text-gray-400">Active SKUs</div>
        </div>
      </div>

      {/* Pending Leases */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">
            Pending Leases
            {pendingLeases.length > 0 && (
              <span className="ml-2 rounded-full bg-yellow-600 px-2 py-0.5 text-xs">
                {pendingLeases.length}
              </span>
            )}
          </h2>
          <button
            onClick={fetchData}
            className="rounded border border-gray-600 px-3 py-1 text-sm text-gray-400 hover:bg-gray-700 hover:text-white"
          >
            Refresh
          </button>
        </div>
        {pendingLeases.length === 0 ? (
          <p className="text-gray-400">No pending leases to review</p>
        ) : (
          <div className="space-y-3">
            {pendingLeases.map((lease) => (
              <PendingLeaseCard
                key={lease.uuid}
                lease={lease}
                getSKU={getSKU}
                onAcknowledge={handleAcknowledge}
                onReject={handleReject}
                txLoading={txStatus?.loading || false}
              />
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
              <ActiveLeaseCard
                key={lease.uuid}
                lease={lease}
                getSKU={getSKU}
                withdrawable={withdrawableAmounts.get(lease.uuid) || []}
                onWithdraw={() => handleWithdraw([lease.uuid])}
                onClose={() => handleCloseLease(lease.uuid)}
                txLoading={txStatus?.loading || false}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PendingLeaseCard({
  lease,
  getSKU,
  onAcknowledge,
  onReject,
  txLoading,
}: {
  lease: Lease;
  getSKU: (uuid: string) => SKU | undefined;
  onAcknowledge: (uuid: string) => void;
  onReject: (uuid: string, reason: string) => void;
  txLoading: boolean;
}) {
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [showFullUuid, setShowFullUuid] = useState(false);

  return (
    <div className="rounded-lg border border-yellow-600/30 bg-yellow-900/10 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowFullUuid(!showFullUuid)}
              className="font-mono text-sm text-gray-300 hover:text-white"
            >
              {showFullUuid ? lease.uuid : `${lease.uuid.slice(0, 20)}...`}
            </button>
            {showFullUuid && (
              <button
                onClick={() => copyToClipboard(lease.uuid)}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                Copy
              </button>
            )}
          </div>
          <div className="mt-1 text-sm text-gray-400">
            Tenant: <span className="font-mono">{formatAddress(lease.tenant)}</span>
          </div>
          <div className="text-xs text-gray-500">
            Created: {new Date(lease.created_at).toLocaleString()}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onAcknowledge(lease.uuid)}
            disabled={txLoading}
            className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Acknowledge
          </button>
          <button
            onClick={() => setShowRejectForm(!showRejectForm)}
            disabled={txLoading}
            className="rounded border border-red-600 px-4 py-2 text-sm text-red-400 hover:bg-red-900/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </div>

      {/* Items */}
      <div className="mb-3 rounded bg-gray-800/50 p-2">
        <div className="text-xs font-medium uppercase text-gray-500">Requested Items</div>
        {lease.items.map((item, idx) => {
          const sku = getSKU(item.sku_uuid);
          return (
            <div key={idx} className="mt-1 flex justify-between text-sm">
              <span className="text-white">
                {sku?.name || item.sku_uuid.slice(0, 8) + '...'} × {item.quantity}
              </span>
              <span className="text-gray-400">
                {formatPrice(item.locked_price.amount, item.locked_price.denom)}/sec
              </span>
            </div>
          );
        })}
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
              disabled={txLoading}
            />
            <button
              onClick={() => {
                onReject(lease.uuid, rejectReason);
                setShowRejectForm(false);
                setRejectReason('');
              }}
              disabled={txLoading}
              className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Confirm Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ActiveLeaseCard({
  lease,
  getSKU,
  withdrawable,
  onWithdraw,
  onClose,
  txLoading,
}: {
  lease: Lease;
  getSKU: (uuid: string) => SKU | undefined;
  withdrawable: Coin[];
  onWithdraw: () => void;
  onClose: () => void;
  txLoading: boolean;
}) {
  const [showFullUuid, setShowFullUuid] = useState(false);

  const hourlyRate = () => {
    let total = 0;
    let denom = '';
    for (const item of lease.items) {
      const perSecond = parseInt(item.locked_price.amount, 10);
      total += perSecond * parseInt(item.quantity, 10) * 3600;
      denom = item.locked_price.denom;
    }
    const meta = DENOM_METADATA[denom];
    const symbol = meta?.symbol || denom;
    const exponent = meta?.exponent || 6;
    return `${(total / Math.pow(10, exponent)).toFixed(4)} ${symbol}/hr`;
  };

  return (
    <div className="rounded-lg border border-green-600/30 bg-green-900/10 p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowFullUuid(!showFullUuid)}
              className="font-mono text-sm text-gray-300 hover:text-white"
            >
              {showFullUuid ? lease.uuid : `${lease.uuid.slice(0, 20)}...`}
            </button>
            {showFullUuid && (
              <button
                onClick={() => copyToClipboard(lease.uuid)}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                Copy
              </button>
            )}
          </div>
          <div className="mt-1 text-sm text-gray-400">
            Tenant: <span className="font-mono">{formatAddress(lease.tenant)}</span>
          </div>
          <div className="text-xs text-gray-500">
            Active since: {lease.acknowledged_at ? new Date(lease.acknowledged_at).toLocaleString() : '-'}
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm text-gray-400">Withdrawable</div>
          {withdrawable.length === 0 ? (
            <div className="font-bold text-gray-500">0</div>
          ) : (
            withdrawable.map((coin, idx) => (
              <div key={idx} className="font-bold text-green-400">
                {formatPrice(coin.amount, coin.denom)}
              </div>
            ))
          )}
          <div className="text-xs text-gray-500">@ {hourlyRate()}</div>
        </div>
      </div>

      {/* Items */}
      <div className="mt-3 rounded bg-gray-800/50 p-2">
        {lease.items.map((item, idx) => {
          const sku = getSKU(item.sku_uuid);
          return (
            <div key={idx} className="flex justify-between text-sm">
              <span className="text-white">
                {sku?.name || item.sku_uuid.slice(0, 8) + '...'} × {item.quantity}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          onClick={onWithdraw}
          disabled={txLoading || withdrawable.length === 0}
          className="rounded border border-green-600 px-3 py-1 text-sm text-green-400 hover:bg-green-900/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Withdraw
        </button>
        <button
          onClick={onClose}
          disabled={txLoading}
          className="rounded border border-orange-600 px-3 py-1 text-sm text-orange-400 hover:bg-orange-900/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Close Lease
        </button>
      </div>
    </div>
  );
}
