import { useState, useEffect, useCallback } from 'react';
import { useChain } from '@cosmos-kit/react';
import {
  getBalance,
  getCreditAccount,
  getCreditEstimate,
  fundCredit,
  DENOMS,
  DENOM_METADATA,
} from '../../api';
import type { Coin } from '../../api/bank';
import type { CreditAccountResponse, CreditEstimateResponse } from '../../api/billing';

const CHAIN_NAME = 'manifestlocal';

interface WalletTabProps {
  isConnected: boolean;
  address?: string;
  onConnect: () => void;
}

interface WalletData {
  mfxBalance: Coin | null;
  pwrBalance: Coin | null;
  creditAccount: CreditAccountResponse | null;
  creditEstimate: CreditEstimateResponse | null;
  loading: boolean;
  error: string | null;
}

export function WalletTab({ isConnected, address, onConnect }: WalletTabProps) {
  const { getOfflineSignerDirect } = useChain(CHAIN_NAME);
  const [fundAmount, setFundAmount] = useState('');
  const [txLoading, setTxLoading] = useState(false);
  const [txResult, setTxResult] = useState<{ success: boolean; message: string } | null>(null);
  const [data, setData] = useState<WalletData>({
    mfxBalance: null,
    pwrBalance: null,
    creditAccount: null,
    creditEstimate: null,
    loading: false,
    error: null,
  });

  const fetchData = useCallback(async () => {
    if (!address) return;

    setData((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const [mfxBalance, pwrBalance, creditAccount, creditEstimate] = await Promise.all([
        getBalance(address, DENOMS.MFX).catch(() => ({ denom: DENOMS.MFX, amount: '0' })),
        getBalance(address, DENOMS.PWR).catch(() => ({ denom: DENOMS.PWR, amount: '0' })),
        getCreditAccount(address).catch(() => null),
        getCreditEstimate(address).catch(() => null),
      ]);

      setData({
        mfxBalance,
        pwrBalance,
        creditAccount,
        creditEstimate,
        loading: false,
        error: null,
      });
    } catch (err) {
      setData((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch data',
      }));
    }
  }, [address]);

  useEffect(() => {
    if (isConnected && address) {
      fetchData();
    }
  }, [isConnected, address, fetchData]);

  const handleFundCredit = async () => {
    if (!address || !fundAmount) return;

    setTxLoading(true);
    setTxResult(null);

    try {
      const signer = getOfflineSignerDirect();
      if (!signer) {
        throw new Error('Failed to get signer');
      }

      // Convert display amount to base amount (multiply by 10^6)
      const baseAmount = (parseFloat(fundAmount) * 1_000_000).toFixed(0);

      const result = await fundCredit(signer, address, address, {
        denom: DENOMS.PWR,
        amount: baseAmount,
      });

      if (result.success) {
        setTxResult({
          success: true,
          message: `Successfully funded ${fundAmount} PWR! Tx: ${result.transactionHash?.slice(0, 16)}...`,
        });
        setFundAmount('');
        // Refresh data after successful tx
        setTimeout(fetchData, 1000);
      } else {
        setTxResult({
          success: false,
          message: result.error || 'Transaction failed',
        });
      }
    } catch (err) {
      setTxResult({
        success: false,
        message: err instanceof Error ? err.message : 'Transaction failed',
      });
    } finally {
      setTxLoading(false);
    }
  };

  const formatAmount = (amount: string, denom: string) => {
    const metadata = DENOM_METADATA[denom as keyof typeof DENOM_METADATA];
    const exponent = metadata?.exponent ?? 6;
    const symbol = metadata?.symbol ?? denom;
    const num = parseInt(amount, 10) / Math.pow(10, exponent);
    return `${num.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`;
  };

  const formatDuration = (seconds: number) => {
    if (seconds <= 0) return '0h';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
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
          Connect Wallet
        </button>
      </div>
    );
  }

  const { mfxBalance, pwrBalance, creditAccount, creditEstimate, loading, error } = data;

  // Find PWR balance in credit account
  const creditPwrBalance = creditAccount?.balances?.find((b) => b.denom === DENOMS.PWR);

  // Find burn rate for PWR (total_rate_per_second is an array of Coins)
  const pwrRatePerSecond = creditEstimate?.total_rate_per_second?.find(
    (c) => c.denom === DENOMS.PWR || c.denom === 'upwr'
  );
  const burnRatePerHour = pwrRatePerSecond
    ? parseInt(pwrRatePerSecond.amount, 10) * 3600
    : 0;

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

      {/* Connected Address */}
      {address && (
        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Connected Address</h2>
            <button
              onClick={fetchData}
              disabled={loading}
              className="rounded border border-gray-600 px-3 py-1 text-sm text-gray-400 hover:bg-gray-700 disabled:opacity-50"
            >
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
          <div className="mt-2 font-mono text-sm text-gray-300 break-all">{address}</div>
        </div>
      )}

      {/* Wallet Balances Card */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Wallet Balances</h2>
        {loading && !mfxBalance ? (
          <div className="text-gray-400">Loading...</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg bg-gray-700/50 p-4">
              <div className="text-sm text-gray-400">MFX Balance</div>
              <div className="text-2xl font-bold text-white">
                {mfxBalance ? formatAmount(mfxBalance.amount, mfxBalance.denom) : '0 MFX'}
              </div>
            </div>
            <div className="rounded-lg bg-gray-700/50 p-4">
              <div className="text-sm text-gray-400">PWR Balance</div>
              <div className="text-2xl font-bold text-purple-400">
                {pwrBalance ? formatAmount(pwrBalance.amount, pwrBalance.denom) : '0 PWR'}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Credit Account Card */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Credit Account</h2>

        {loading && !creditAccount ? (
          <div className="text-gray-400">Loading...</div>
        ) : (
          <>
            <div className="mb-6 grid gap-4 sm:grid-cols-3">
              <div className="rounded-lg bg-gray-700/50 p-4">
                <div className="text-sm text-gray-400">Credit Balance (PWR)</div>
                <div className="text-2xl font-bold text-green-400">
                  {creditPwrBalance
                    ? formatAmount(creditPwrBalance.amount, creditPwrBalance.denom)
                    : '0 PWR'}
                </div>
              </div>
              <div className="rounded-lg bg-gray-700/50 p-4">
                <div className="text-sm text-gray-400">Burn Rate</div>
                <div className="text-2xl font-bold text-orange-400">
                  {burnRatePerHour > 0
                    ? `${formatAmount(String(burnRatePerHour), DENOMS.PWR)}/hr`
                    : '0 PWR/hr'}
                </div>
              </div>
              <div className="rounded-lg bg-gray-700/50 p-4">
                <div className="text-sm text-gray-400">Time Remaining</div>
                <div className="text-2xl font-bold text-blue-400">
                  {creditEstimate?.estimated_duration_seconds
                    ? formatDuration(parseInt(creditEstimate.estimated_duration_seconds, 10))
                    : '-'}
                </div>
              </div>
            </div>

            <div className="mb-4 grid gap-4 sm:grid-cols-2">
              <div className="rounded bg-gray-700/30 p-3">
                <span className="text-gray-400">Active Leases: </span>
                <span className="font-medium text-white">
                  {creditAccount?.credit_account?.active_lease_count ?? 0}
                </span>
              </div>
              <div className="rounded bg-gray-700/30 p-3">
                <span className="text-gray-400">Pending Leases: </span>
                <span className="font-medium text-white">
                  {creditAccount?.credit_account?.pending_lease_count ?? 0}
                </span>
              </div>
            </div>

            <div className="text-sm text-gray-500">
              <span>Credit Address: </span>
              <span className="font-mono break-all">
                {creditAccount?.credit_account?.credit_address ?? '-'}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Fund Credit Card */}
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Fund Credit Account</h2>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mb-2 block text-sm text-gray-400">Amount (PWR)</label>
            <input
              type="number"
              value={fundAmount}
              onChange={(e) => setFundAmount(e.target.value)}
              placeholder="Enter amount"
              disabled={txLoading}
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-4 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none disabled:opacity-50"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={handleFundCredit}
              disabled={!fundAmount || txLoading}
              className="rounded-lg bg-green-600 px-6 py-2 font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {txLoading ? 'Signing...' : 'Fund Credit'}
            </button>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          {[10, 50, 100, 500].map((amount) => (
            <button
              key={amount}
              onClick={() => setFundAmount(String(amount))}
              disabled={txLoading}
              className="rounded border border-gray-600 px-3 py-1 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50"
            >
              {amount} PWR
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
