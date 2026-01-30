import { useState, useCallback } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Link, Wallet, Clock, Flame, Loader2, Copy, Check, ChevronUp, Zap, TrendingDown } from 'lucide-react';
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
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';

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
  const { copied, copyToClipboard } = useCopyToClipboard();
  const [fundAmount, setFundAmount] = useState('');
  const [txLoading, setTxLoading] = useState(false);
  const [showFundPanel, setShowFundPanel] = useState(false);
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
        toast.success(`Funded ${fundAmount} PWR! Tx: ${result.transactionHash?.slice(0, 16)}...`);
        setFundAmount('');
        setShowFundPanel(false);
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
  const timeRemaining = creditEstimate?.estimated_duration_seconds
    ? parseInt(creditEstimate.estimated_duration_seconds, 10)
    : 0;

  // Determine credit health status
  const getCreditStatus = () => {
    if (!creditPwrBalance || parseInt(creditPwrBalance.amount, 10) === 0) return 'empty';
    if (timeRemaining > 0 && timeRemaining < 3600) return 'critical'; // < 1 hour
    if (timeRemaining > 0 && timeRemaining < 86400) return 'low'; // < 24 hours
    return 'healthy';
  };
  const creditStatus = getCreditStatus();

  if (loading && !mfxBalance) {
    return (
      <div className="space-y-3">
        <div className="wallet-card">
          <div className="wallet-card-row">
            <div className="skeleton h-4 w-32" />
            <div className="skeleton h-6 w-48" />
          </div>
        </div>
        <div className="wallet-card">
          <div className="wallet-card-row">
            <div className="skeleton h-4 w-32" />
            <div className="skeleton h-6 w-48" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Error Banner */}
      {error && (
        <div className="wallet-error">
          <span>{error}</span>
          <button onClick={autoRefresh.refresh} className="btn btn-ghost btn-xs">
            Retry
          </button>
        </div>
      )}

      {/* Wallet Balances Card */}
      <div className="wallet-card">
        <div className="wallet-card-header">
          <div className="wallet-card-title">
            <Wallet size={14} />
            Wallet Balances
          </div>
          <AutoRefreshIndicator autoRefresh={autoRefresh} intervalSeconds={10} />
        </div>

        <div className="wallet-card-body">
          <div className="wallet-balance-row">
            <div className="wallet-balance" data-token="mfx">
              <span className="wallet-balance-value">
                {mfxBalance ? formatAmount(mfxBalance.amount, mfxBalance.denom, 2) : '0 MFX'}
              </span>
              <span className="wallet-balance-label">MFX</span>
            </div>

            <div className="wallet-balance-divider" />

            <div className="wallet-balance" data-token="pwr">
              <span className="wallet-balance-value">
                {pwrBalance ? formatAmount(pwrBalance.amount, pwrBalance.denom, 2) : '0 PWR'}
              </span>
              <span className="wallet-balance-label">PWR (Available)</span>
            </div>
          </div>
        </div>
      </div>

      {/* Credit Account Card */}
      <div className="wallet-card" data-status={creditStatus}>
        <div className="wallet-card-header">
          <div className="wallet-card-title">
            <Flame size={14} />
            Credit Account
          </div>
          <div className="wallet-card-actions">
            <button
              onClick={() => setShowFundPanel(!showFundPanel)}
              className="btn btn-primary btn-sm"
            >
              {showFundPanel ? 'Cancel' : 'Fund'}
            </button>
          </div>
        </div>

        <div className="wallet-card-body">
          {/* Main metrics row */}
          <div className="wallet-metrics-row">
            <div className="wallet-metric" data-type="balance">
              <span className="wallet-metric-icon">
                <Zap size={12} />
              </span>
              <span className="wallet-metric-value">
                {creditPwrBalance
                  ? formatAmount(creditPwrBalance.amount, creditPwrBalance.denom, 2)
                  : '0 PWR'}
              </span>
              <span className="wallet-metric-label">Credit Balance</span>
            </div>

            <div className="wallet-metric" data-type="burn">
              <span className="wallet-metric-icon">
                <TrendingDown size={12} />
              </span>
              <span className="wallet-metric-value">
                {burnRatePerHour > 0
                  ? `${formatAmount(String(burnRatePerHour), DENOMS.PWR, 4)}/hr`
                  : '0/hr'}
              </span>
              <span className="wallet-metric-label">Burn Rate</span>
            </div>

            <div className="wallet-metric" data-type="time">
              <span className="wallet-metric-icon">
                <Clock size={12} />
              </span>
              <span className="wallet-metric-value">
                {timeRemaining > 0 ? formatDuration(timeRemaining) : '-'}
              </span>
              <span className="wallet-metric-label">Time Left</span>
            </div>
          </div>

          {/* Lease counts row */}
          <div className="wallet-stats-row">
            <div className="wallet-stat">
              <span className="wallet-stat-label">Active</span>
              <span className="wallet-stat-value" data-type="active">
                {creditAccount?.credit_account?.active_lease_count ?? 0}
              </span>
            </div>
            <div className="wallet-stat">
              <span className="wallet-stat-label">Pending</span>
              <span className="wallet-stat-value" data-type="pending">
                {creditAccount?.credit_account?.pending_lease_count ?? 0}
              </span>
            </div>
          </div>

          {/* Credit address */}
          {creditAccount?.credit_account?.credit_address && (
            <div className="wallet-address-row">
              <span className="wallet-address-label">Credit Address</span>
              <code className="wallet-address-value">
                {creditAccount.credit_account.credit_address}
              </code>
              <button
                onClick={() => copyToClipboard(creditAccount.credit_account?.credit_address || '')}
                className="wallet-copy-btn"
                title="Copy address"
              >
                {copied ? <Check size={10} /> : <Copy size={10} />}
              </button>
            </div>
          )}
        </div>

        {/* Fund Panel (inline) */}
        {showFundPanel && (
          <div className="wallet-fund-panel">
            <div className="wallet-fund-header">
              <span className="wallet-fund-title">Fund Credit Account</span>
              <button
                onClick={() => setShowFundPanel(false)}
                className="wallet-fund-close"
              >
                <ChevronUp size={14} />
              </button>
            </div>

            <div className="wallet-fund-body">
              <div className="wallet-fund-input-row">
                <input
                  type="number"
                  value={fundAmount}
                  onChange={(e) => setFundAmount(e.target.value)}
                  placeholder="Amount"
                  disabled={txLoading}
                  min="0.000001"
                  max="999999999"
                  step="0.000001"
                  className="wallet-fund-input"
                />
                <span className="wallet-fund-denom">PWR</span>
                <button
                  onClick={handleFundCredit}
                  disabled={!fundAmount || txLoading}
                  className="btn btn-success btn-sm"
                >
                  {txLoading ? (
                    <Loader2 className="animate-spin" size={14} />
                  ) : (
                    'Fund'
                  )}
                </button>
              </div>

              <div className="wallet-fund-presets">
                {[10, 50, 100, 500].map((amount) => (
                  <button
                    key={amount}
                    onClick={() => setFundAmount(String(amount))}
                    disabled={txLoading}
                    className="wallet-fund-preset"
                  >
                    {amount}
                  </button>
                ))}
              </div>

              {pwrBalance && (
                <div className="wallet-fund-available">
                  Available: {formatAmount(pwrBalance.amount, pwrBalance.denom, 2)}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
