import { useState, useCallback, useEffect } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Link, Wallet, Clock, Flame, Loader2, Copy, Check, Zap, TrendingDown, Plus, ArrowRight, GitBranch } from 'lucide-react';
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
import { useAutoRefreshContext } from '../../contexts/AutoRefreshContext';
import { useToast } from '../../hooks/useToast';
import { EmptyState } from '../ui/EmptyState';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { truncateAddress } from '../../utils/address';
import { CHAIN_NAME } from '../../config/chain';

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

  const { registerFetchFn, unregisterFetchFn, refresh } = useAutoRefreshContext();

  useEffect(() => {
    if (isConnected && address) {
      registerFetchFn(fetchData);
    }
    return () => unregisterFetchFn();
  }, [isConnected, address, fetchData, registerFetchFn, unregisterFetchFn]);

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
        refresh();
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
  const creditBalanceNum = creditPwrBalance ? parseInt(creditPwrBalance.amount, 10) / 1_000_000 : 0;
  const pwrBalanceNum = pwrBalance ? parseInt(pwrBalance.amount, 10) / 1_000_000 : 0;
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

  // Calculate gauge percentage (capped at 100%, 7 days = full)
  const maxGaugeSeconds = 7 * 24 * 3600; // 7 days
  const gaugePercent = Math.min((timeRemaining / maxGaugeSeconds) * 100, 100);

  if (loading && !mfxBalance) {
    return (
      <div className="wallet-dashboard">
        <div className="wallet-skeleton-grid">
          <div className="skeleton wallet-skeleton-balance" />
          <div className="skeleton wallet-skeleton-fund" />
          <div className="skeleton wallet-skeleton-credit" />
        </div>
      </div>
    );
  }

  return (
    <div className="wallet-dashboard">
      {/* Error Banner */}
      {error && (
        <div className="wallet-error">
          <span>{error}</span>
          <button onClick={refresh} className="btn btn-ghost btn-xs">
            Retry
          </button>
        </div>
      )}

      {/* Top Row: Balances + Fund Action */}
      <div className="wallet-top-row">
        {/* Wallet Balances */}
        <div className="wallet-balances-card">
          <div className="wallet-balances-header">
            <div className="wallet-balances-title">
              <Wallet size={14} />
              Wallet
            </div>
          </div>
          <div className="wallet-balances-grid">
            <div className="wallet-token" data-token="mfx">
              <span className="wallet-token-value">
                {mfxBalance ? formatAmount(mfxBalance.amount, mfxBalance.denom, 2) : '0 MFX'}
              </span>
              <span className="wallet-token-label">MFX Balance</span>
            </div>
            <div className="wallet-token" data-token="pwr">
              <span className="wallet-token-value">
                {pwrBalance ? formatAmount(pwrBalance.amount, pwrBalance.denom, 2) : '0 PWR'}
              </span>
              <span className="wallet-token-label">PWR Available</span>
            </div>
          </div>
        </div>

        {/* Fund Action Card - Always Visible */}
        <div className="wallet-fund-card">
          <div className="wallet-fund-card-header">
            <span className="wallet-fund-card-title">
              <Plus size={14} />
              Fund Credit
            </span>
          </div>
          <div className="wallet-fund-card-body">
            <div className="wallet-fund-input-group">
              <input
                type="number"
                value={fundAmount}
                onChange={(e) => setFundAmount(e.target.value)}
                placeholder="0"
                disabled={txLoading}
                min="0.000001"
                max="999999999"
                step="0.000001"
                className="wallet-fund-amount-input"
              />
              <span className="wallet-fund-amount-denom">PWR</span>
            </div>
            <div className="wallet-fund-presets">
              {[10, 50, 100].map((amount) => (
                <button
                  key={amount}
                  onClick={() => setFundAmount(String(amount))}
                  disabled={txLoading}
                  className="wallet-fund-preset-btn"
                >
                  {amount}
                </button>
              ))}
            </div>
            <button
              onClick={handleFundCredit}
              disabled={!fundAmount || txLoading || pwrBalanceNum < parseFloat(fundAmount)}
              className="wallet-fund-submit-btn"
            >
              {txLoading ? (
                <Loader2 className="animate-spin" size={16} />
              ) : (
                <>
                  Fund Account
                  <ArrowRight size={14} />
                </>
              )}
            </button>
            <div className="wallet-fund-available">
              {pwrBalanceNum.toLocaleString(undefined, { maximumFractionDigits: 2 })} PWR available
            </div>
          </div>
        </div>
      </div>

      {/* Credit Account Section */}
      <div className="wallet-credit-card" data-status={creditStatus}>
        <div className="wallet-credit-header">
          <div className="wallet-credit-title">
            <Flame size={14} />
            Credit Account
          </div>
          {creditStatus === 'critical' && (
            <span className="wallet-credit-alert">Low Balance</span>
          )}
          {creditStatus === 'low' && (
            <span className="wallet-credit-warning">Running Low</span>
          )}
        </div>

        <div className="wallet-credit-body">
          {/* Fuel Gauge */}
          <div className="fuel-gauge" data-status={creditStatus}>
            <div className="fuel-gauge-display">
              <div className="fuel-gauge-readout">
                <span className="fuel-gauge-value">
                  {timeRemaining > 0 ? formatDuration(timeRemaining) : '—'}
                </span>
                <span className="fuel-gauge-label">remaining</span>
              </div>
              <div className="fuel-gauge-meter">
                <div className="fuel-gauge-track">
                  <div
                    className="fuel-gauge-fill"
                    style={{ width: `${gaugePercent}%` }}
                  />
                  <div className="fuel-gauge-glow" style={{ width: `${gaugePercent}%` }} />
                  {/* Tick marks */}
                  <div className="fuel-gauge-ticks">
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((day) => (
                      <div
                        key={day}
                        className="fuel-gauge-tick"
                        style={{ left: `${(day / 7) * 100}%` }}
                        data-major={day % 7 === 0 || day === 7 ? 'true' : 'false'}
                      />
                    ))}
                  </div>
                </div>
                <div className="fuel-gauge-scale">
                  <span>0</span>
                  <span>1d</span>
                  <span>2d</span>
                  <span>3d</span>
                  <span>4d</span>
                  <span>5d</span>
                  <span>6d</span>
                  <span>7d</span>
                </div>
              </div>
            </div>
          </div>

          {/* Metrics Grid */}
          <div className="wallet-credit-metrics">
            <div className="wallet-credit-metric" data-type="balance">
              <div className="wallet-credit-metric-icon">
                <Zap size={14} />
              </div>
              <div className="wallet-credit-metric-content">
                <span className="wallet-credit-metric-value">
                  {creditBalanceNum.toLocaleString(undefined, { maximumFractionDigits: 2 })} PWR
                </span>
                <span className="wallet-credit-metric-label">Credit Balance</span>
              </div>
            </div>

            <div className="wallet-credit-metric" data-type="burn">
              <div className="wallet-credit-metric-icon">
                <TrendingDown size={14} />
              </div>
              <div className="wallet-credit-metric-content">
                <span className="wallet-credit-metric-value">
                  {burnRatePerHour > 0
                    ? `${formatAmount(String(burnRatePerHour), DENOMS.PWR, 4)}/hr`
                    : '0/hr'}
                </span>
                <span className="wallet-credit-metric-label">Burn Rate</span>
              </div>
            </div>

            <div className="wallet-credit-metric" data-type="active">
              <div className="wallet-credit-metric-icon">
                <Flame size={14} />
              </div>
              <div className="wallet-credit-metric-content">
                <span className="wallet-credit-metric-value">
                  {creditAccount?.credit_account?.active_lease_count ?? 0}
                </span>
                <span className="wallet-credit-metric-label">Active Leases</span>
              </div>
            </div>

            <div className="wallet-credit-metric" data-type="pending">
              <div className="wallet-credit-metric-icon">
                <Clock size={14} />
              </div>
              <div className="wallet-credit-metric-content">
                <span className="wallet-credit-metric-value">
                  {creditAccount?.credit_account?.pending_lease_count ?? 0}
                </span>
                <span className="wallet-credit-metric-label">Pending Leases</span>
              </div>
            </div>
          </div>

          {/* Address Derivation Flow */}
          {creditAccount?.credit_account?.credit_address && address && (
            <div className="address-derivation">
              <div className="address-derivation-node" data-type="source">
                <span className="address-derivation-label">Your Wallet</span>
                <code className="address-derivation-value">{truncateAddress(address, 11, 6)}</code>
              </div>
              <div className="address-derivation-connector">
                <div className="address-derivation-line" />
                <div className="address-derivation-transform">
                  <GitBranch size={12} />
                </div>
                <div className="address-derivation-line" />
              </div>
              <div className="address-derivation-node" data-type="derived">
                <span className="address-derivation-label">Credit Account</span>
                <div className="address-derivation-value-row">
                  <code className="address-derivation-value">{truncateAddress(creditAccount.credit_account.credit_address, 11, 6)}</code>
                  <button
                    onClick={() => copyToClipboard(creditAccount.credit_account?.credit_address || '')}
                    className="address-derivation-copy"
                    title="Copy credit address"
                  >
                    {copied ? <Check size={10} /> : <Copy size={10} />}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
