import { useState } from 'react';
import { mockCreditAccount, mockCreditEstimate, mockWalletBalance } from '../../mockData';

interface WalletTabProps {
  isConnected: boolean;
  onConnect: () => void;
}

export function WalletTab({ isConnected, onConnect }: WalletTabProps) {
  const [fundAmount, setFundAmount] = useState('');

  const formatAmount = (amount: string, denom: string) => {
    const num = parseInt(amount, 10) / 1_000_000;
    return `${num.toLocaleString()} ${denom.replace('u', '').toUpperCase()}`;
  };

  const formatDuration = (seconds: number) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    if (days > 0) return `${days}d ${hours}h`;
    return `${hours}h`;
  };

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="mb-6 text-6xl">🔗</div>
        <h2 className="mb-4 text-2xl font-semibold text-white">Connect Your Wallet</h2>
        <p className="mb-8 text-gray-400">Connect your wallet to manage credit and create leases</p>
        <button
          onClick={onConnect}
          className="rounded-lg bg-blue-600 px-6 py-3 text-lg font-medium text-white hover:bg-blue-700"
        >
          Connect Keplr Wallet
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Wallet Balance Card */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Wallet Balance</h2>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold text-white">
            {formatAmount(mockWalletBalance.amount, mockWalletBalance.denom)}
          </span>
          <span className="text-gray-400">available</span>
        </div>
      </div>

      {/* Credit Account Card */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Credit Account</h2>

        <div className="mb-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg bg-gray-700/50 p-4">
            <div className="text-sm text-gray-400">Credit Balance</div>
            <div className="text-2xl font-bold text-green-400">
              {formatAmount(mockCreditAccount.balance.amount, mockCreditAccount.balance.denom)}
            </div>
          </div>
          <div className="rounded-lg bg-gray-700/50 p-4">
            <div className="text-sm text-gray-400">Burn Rate</div>
            <div className="text-2xl font-bold text-orange-400">
              {formatAmount(String(parseInt(mockCreditEstimate.burnRatePerSecond.amount) * 3600), mockCreditEstimate.burnRatePerSecond.denom)}/hr
            </div>
          </div>
          <div className="rounded-lg bg-gray-700/50 p-4">
            <div className="text-sm text-gray-400">Time Remaining</div>
            <div className="text-2xl font-bold text-blue-400">
              {formatDuration(mockCreditEstimate.remainingSeconds)}
            </div>
          </div>
        </div>

        <div className="mb-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded bg-gray-700/30 p-3">
            <span className="text-gray-400">Active Leases: </span>
            <span className="font-medium text-white">{mockCreditAccount.activeleaseCount}</span>
          </div>
          <div className="rounded bg-gray-700/30 p-3">
            <span className="text-gray-400">Pending Leases: </span>
            <span className="font-medium text-white">{mockCreditAccount.pendingLeaseCount}</span>
          </div>
        </div>

        <div className="text-sm text-gray-500">
          Credit Address: <span className="font-mono">{mockCreditAccount.creditAddress}</span>
        </div>
      </div>

      {/* Fund Credit Card */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Fund Credit Account</h2>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mb-2 block text-sm text-gray-400">Amount (MFX)</label>
            <input
              type="number"
              value={fundAmount}
              onChange={(e) => setFundAmount(e.target.value)}
              placeholder="Enter amount"
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-4 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={() => alert(`Would fund ${fundAmount} MFX to credit account`)}
              disabled={!fundAmount}
              className="rounded-lg bg-green-600 px-6 py-2 font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Fund Credit
            </button>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          {[10, 50, 100, 500].map((amount) => (
            <button
              key={amount}
              onClick={() => setFundAmount(String(amount))}
              className="rounded border border-gray-600 px-3 py-1 text-sm text-gray-300 hover:bg-gray-700"
            >
              {amount} MFX
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
