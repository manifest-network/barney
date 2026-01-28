import { useState, useCallback } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Link, Wallet, Clock, Flame, Loader2 } from 'lucide-react';
import {
  getBalance,
  getCreditAccount,
  getCreditEstimate,
  fundCredit,
  DENOMS,
} from '../../api';
import { formatAmount } from '../../utils/format';
import type { Coin } from '../../api/bank';
import type { CreditAccountResponse, CreditEstimateResponse } from '../../api/billing';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';
import { AutoRefreshIndicator } from '../ui/AutoRefreshIndicator';
import { useToast } from '../../hooks/useToast';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonStat, SkeletonStatGrid } from '../ui/SkeletonStat';
import { SectionHeader } from '../ui/SectionHeader';
import { ErrorBanner } from '../ui/ErrorBanner';

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
  const toast = useToast();
  const [fundAmount, setFundAmount] = useState('');
  const [txLoading, setTxLoading] = useState(false);
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

    // Only show loading on initial fetch, not on refreshes
    setData((prev) => {
      if (!prev.mfxBalance) {
        return { ...prev, loading: true, error: null };
      }
      return prev;
    });

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

  const autoRefresh = useAutoRefresh(fetchData, {
    interval: 10000,
    enabled: isConnected && !!address,
    immediate: true,
  });

  const handleFundCredit = async () => {
    if (!address || !fundAmount) return;

    // Validate the amount is a valid positive number
    const parsedAmount = parseFloat(fundAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0 || !isFinite(parsedAmount)) {
      toast.error('Please enter a valid positive amount');
      return;
    }

    setTxLoading(true);

    try {
      const signer = getOfflineSignerDirect();
      if (!signer) {
        throw new Error('Failed to get signer');
      }

      const baseAmount = (parsedAmount * 1_000_000).toFixed(0);

      const result = await fundCredit(signer, address, address, {
        denom: DENOMS.PWR,
        amount: baseAmount,
      });

      if (result.success) {
        toast.success(`Successfully funded ${fundAmount} PWR! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        setFundAmount('');
        autoRefresh.refresh();
      } else {
        toast.error(result.error || 'Transaction failed');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setTxLoading(false);
    }
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
      <EmptyState
        icon={Link}
        title="Connect Your Wallet"
        description="Connect your wallet to manage credit and create leases"
        action={{ label: 'Connect Wallet', onClick: onConnect }}
      />
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
      {error && <ErrorBanner error={error} onRetry={autoRefresh.refresh} />}

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
        <SectionHeader icon={Wallet} title="Wallet Balances" />
        {loading && !mfxBalance ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <SkeletonStat />
            <SkeletonStat />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="stat-card">
              <div className="stat-value text-primary">
                {mfxBalance ? formatAmount(mfxBalance.amount, mfxBalance.denom) : '0 MFX'}
              </div>
              <div className="stat-label">MFX Balance</div>
            </div>
            <div className="stat-card">
              <div className="stat-value text-secondary-400">
                {pwrBalance ? formatAmount(pwrBalance.amount, pwrBalance.denom) : '0 PWR'}
              </div>
              <div className="stat-label">PWR Balance</div>
            </div>
          </div>
        )}
      </div>

      {/* Credit Account Card */}
      <div className="card-static p-6">
        <SectionHeader icon={Flame} title="Credit Account" />

        {loading && !creditAccount ? (
          <SkeletonStatGrid count={3} />
        ) : (
          <>
            <div className="mb-6 grid gap-4 sm:grid-cols-3">
              <div className="stat-card">
                <div className="stat-value text-success">
                  {creditPwrBalance
                    ? formatAmount(creditPwrBalance.amount, creditPwrBalance.denom)
                    : '0 PWR'}
                </div>
                <div className="stat-label">Credit Balance (PWR)</div>
              </div>
              <div className="stat-card">
                <div className="stat-value text-warning">
                  {burnRatePerHour > 0
                    ? `${formatAmount(String(burnRatePerHour), DENOMS.PWR)}/hr`
                    : '0 PWR/hr'}
                </div>
                <div className="stat-label">Burn Rate</div>
              </div>
              <div className="stat-card">
                <div className="stat-value text-accent">
                  {creditEstimate?.estimated_duration_seconds
                    ? formatDuration(parseInt(creditEstimate.estimated_duration_seconds, 10))
                    : '-'}
                </div>
                <div className="flex items-center gap-2 stat-label">
                  <Clock size={14} />
                  Time Remaining
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
        <SectionHeader title="Fund Credit Account" description="Add PWR tokens to your credit account" />
        <div className="flex gap-4">
          <div className="flex-1">
            <label htmlFor="fund-amount" className="mb-2 block text-sm text-muted">Amount (PWR)</label>
            <input
              id="fund-amount"
              type="number"
              value={fundAmount}
              onChange={(e) => setFundAmount(e.target.value)}
              placeholder="Enter amount"
              disabled={txLoading}
              min="0.000001"
              max="999999999"
              step="0.000001"
              aria-describedby="fund-amount-help"
              className="input"
            />
            <span id="fund-amount-help" className="sr-only">Enter the amount of PWR tokens to fund your credit account</span>
          </div>
          <div className="flex items-end">
            <button
              onClick={handleFundCredit}
              disabled={!fundAmount || txLoading}
              className="btn btn-success"
            >
              {txLoading ? (
                <>
                  <Loader2 className="animate-spin" size={16} />
                  Signing...
                </>
              ) : (
                'Fund Credit'
              )}
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
