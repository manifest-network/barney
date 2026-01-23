import { useState, useCallback } from 'react';
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
import { useAutoRefresh } from '../../hooks/useAutoRefresh';
import { AutoRefreshIndicator } from '../AutoRefreshIndicator';

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

    if (!data.mfxBalance) {
      setData((prev) => ({ ...prev, loading: true, error: null }));
    }

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
  }, [address, data.mfxBalance]);

  const autoRefresh = useAutoRefresh(fetchData, {
    interval: 10000,
    enabled: isConnected && !!address,
    immediate: true,
  });

  const handleFundCredit = async () => {
    if (!address || !fundAmount) return;

    setTxLoading(true);
    setTxResult(null);

    try {
      const signer = getOfflineSignerDirect();
      if (!signer) {
        throw new Error('Failed to get signer');
      }

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
        autoRefresh.refresh();
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
      <div className="card-static p-12 text-center">
        <div className="mb-6 text-6xl">🔗</div>
        <h2 className="mb-4 text-2xl font-heading font-semibold">Connect Your Wallet</h2>
        <p className="mb-8 text-muted">Connect your wallet to manage credit and create leases</p>
        <button onClick={onConnect} className="btn btn-primary btn-lg btn-pill">
          Connect Wallet
        </button>
      </div>
    );
  }

  const { mfxBalance, pwrBalance, creditAccount, creditEstimate, loading, error } = data;
  const creditPwrBalance = creditAccount?.balances?.find((b) => b.denom === DENOMS.PWR);
  const pwrRatePerSecond = creditEstimate?.total_rate_per_second?.find(
    (c) => c.denom === DENOMS.PWR || c.denom === 'upwr'
  );
  const burnRatePerHour = pwrRatePerSecond ? parseInt(pwrRatePerSecond.amount, 10) * 3600 : 0;

  return (
    <div className="space-y-6">
      {/* Error Banner */}
      {error && (
        <div className="card-static p-4 border-error-500/50 bg-error-500/10">
          <span className="text-error">{error}</span>
          <button onClick={autoRefresh.refresh} className="ml-4 text-primary-400 hover:underline">
            Retry
          </button>
        </div>
      )}

      {/* Transaction Result Banner */}
      {txResult && (
        <div className={`card-static p-4 ${txResult.success ? 'border-success-500/50 bg-success-500/10' : 'border-error-500/50 bg-error-500/10'}`}>
          <span className={txResult.success ? 'text-success' : 'text-error'}>{txResult.message}</span>
          <button onClick={() => setTxResult(null)} className="ml-4 text-muted hover:text-primary">
            ✕
          </button>
        </div>
      )}

      {/* Connected Address */}
      {address && (
        <div className="card-static p-6">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
            <h2 className="text-lg font-heading font-semibold">Connected Address</h2>
            <AutoRefreshIndicator autoRefresh={autoRefresh} intervalSeconds={10} />
          </div>
          <div className="font-mono text-sm text-secondary break-all">{address}</div>
        </div>
      )}

      {/* Wallet Balances Card */}
      <div className="card-static p-6">
        <h2 className="mb-4 text-lg font-heading font-semibold">Wallet Balances</h2>
        {loading && !mfxBalance ? (
          <div className="text-muted animate-pulse">Loading...</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="stat-card">
              <div className="stat-label">MFX Balance</div>
              <div className="stat-value text-primary">
                {mfxBalance ? formatAmount(mfxBalance.amount, mfxBalance.denom) : '0 MFX'}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">PWR Balance</div>
              <div className="stat-value text-secondary-400">
                {pwrBalance ? formatAmount(pwrBalance.amount, pwrBalance.denom) : '0 PWR'}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Credit Account Card */}
      <div className="card-static p-6">
        <h2 className="mb-4 text-lg font-heading font-semibold">Credit Account</h2>

        {loading && !creditAccount ? (
          <div className="text-muted animate-pulse">Loading...</div>
        ) : (
          <>
            <div className="mb-6 grid gap-4 sm:grid-cols-3">
              <div className="stat-card">
                <div className="stat-label">Credit Balance (PWR)</div>
                <div className="stat-value text-success">
                  {creditPwrBalance
                    ? formatAmount(creditPwrBalance.amount, creditPwrBalance.denom)
                    : '0 PWR'}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Burn Rate</div>
                <div className="stat-value text-warning">
                  {burnRatePerHour > 0
                    ? `${formatAmount(String(burnRatePerHour), DENOMS.PWR)}/hr`
                    : '0 PWR/hr'}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Time Remaining</div>
                <div className="stat-value text-accent">
                  {creditEstimate?.estimated_duration_seconds
                    ? formatDuration(parseInt(creditEstimate.estimated_duration_seconds, 10))
                    : '-'}
                </div>
              </div>
            </div>

            <div className="mb-4 grid gap-4 sm:grid-cols-2">
              <div className="p-3 rounded-lg bg-surface-800/50">
                <span className="text-muted">Active Leases: </span>
                <span className="font-semibold text-success">
                  {creditAccount?.credit_account?.active_lease_count ?? 0}
                </span>
              </div>
              <div className="p-3 rounded-lg bg-surface-800/50">
                <span className="text-muted">Pending Leases: </span>
                <span className="font-semibold text-warning">
                  {creditAccount?.credit_account?.pending_lease_count ?? 0}
                </span>
              </div>
            </div>

            <div className="text-sm text-dim">
              <span>Credit Address: </span>
              <span className="font-mono break-all">
                {creditAccount?.credit_account?.credit_address ?? '-'}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Fund Credit Card */}
      <div className="card-static p-6">
        <h2 className="mb-4 text-lg font-heading font-semibold">Fund Credit Account</h2>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mb-2 block text-sm text-muted">Amount (PWR)</label>
            <input
              type="number"
              value={fundAmount}
              onChange={(e) => setFundAmount(e.target.value)}
              placeholder="Enter amount"
              disabled={txLoading}
              className="input"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={handleFundCredit}
              disabled={!fundAmount || txLoading}
              className="btn btn-success"
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
              className="btn btn-secondary btn-sm"
            >
              {amount} PWR
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
