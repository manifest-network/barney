import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, type FC, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { useAutoRefill, loadCooldowns, saveCooldowns, type UseAutoRefillOptions, type AccountSetupState } from './useAutoRefill';

// --- Mocks ---

vi.mock('../api/bank', () => ({
  getBalance: vi.fn(),
}));

vi.mock('../api/billing', () => ({
  getCreditAccount: vi.fn(),
}));

vi.mock('../api/faucet', () => ({
  requestFaucetTokens: vi.fn(),
  isFaucetEnabled: vi.fn(),
}));

vi.mock('../api/tx', () => ({
  fundCredit: vi.fn(),
}));

vi.mock('../api/config', () => ({
  DENOMS: { MFX: 'umfx', PWR: 'factory/addr/upwr' },
}));

vi.mock('../utils/format', () => ({
  toBaseUnits: (amount: number) => String(amount * 1_000_000),
  fromBaseUnits: (amount: string) => {
    const parsed = parseInt(amount, 10);
    if (Number.isNaN(parsed)) return 0;
    return parsed / 1_000_000;
  },
}));

vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

import { getBalance } from '../api/bank';
import { getCreditAccount } from '../api/billing';
import { requestFaucetTokens, isFaucetEnabled } from '../api/faucet';
import { fundCredit } from '../api/tx';
import { logError } from '../utils/errors';

// --- Helpers ---

const mockToast = { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn(), addToast: vi.fn(), removeToast: vi.fn(), toasts: [] as any[] };
const mockGetOfflineSigner = vi.fn().mockReturnValue({ getAccounts: vi.fn() });
const mockGetOfflineSignerRef = { current: mockGetOfflineSigner };

let container: HTMLDivElement;
let root: Root;
let lastSetupState: AccountSetupState;

/** Wrapper component that calls useAutoRefill with given options and captures state. */
function HookHost(props: UseAutoRefillOptions & { onState?: (s: AccountSetupState) => void }) {
  const { onState, ...hookProps } = props;
  const state = useAutoRefill(hookProps);
  useEffect(() => {
    if (onState) onState(state);
  });
  return null;
}

/** Callback used by HookHost to capture the latest setup state */
const captureState = (s: AccountSetupState) => { lastSetupState = s; };

type HookHostProps = UseAutoRefillOptions & { onState?: (s: AccountSetupState) => void };

function defaultProps(overrides?: Partial<HookHostProps>): HookHostProps {
  return {
    address: 'manifest1test',
    isWalletConnected: true,
    getOfflineSignerRef: mockGetOfflineSignerRef as any,
    toast: mockToast as any,
    onState: captureState,
    ...overrides,
  };
}

function render(props: HookHostProps) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => { root.render(createElement(HookHost as FC, props as any)); });
}

function rerender(props: HookHostProps) {
  flushSync(() => { root.render(createElement(HookHost as FC, props as any)); });
}

/** Flush microtasks so async code in useEffect completes (works with fake timers). */
async function flushMicrotasks() {
  await vi.advanceTimersByTimeAsync(1);
}

function setBalances(mfx: number, pwr: number) {
  vi.mocked(getBalance).mockImplementation(async (_addr: string, denom: string) => {
    if (denom === 'umfx') return { denom, amount: String(mfx * 1_000_000) };
    return { denom, amount: String(pwr * 1_000_000) };
  });
}

function setCreditBalance(pwr: number) {
  vi.mocked(getCreditAccount).mockResolvedValue({
    creditAccount: { tenant: '', creditAddress: '', activeLeaseCount: 0n, pendingLeaseCount: 0n, reservedAmounts: [] },
    balances: [{ denom: 'factory/addr/upwr', amount: String(pwr * 1_000_000) }],
    availableBalances: [],
  });
}

function setEmptyCreditBalance() {
  vi.mocked(getCreditAccount).mockResolvedValue({
    creditAccount: { tenant: '', creditAddress: '', activeLeaseCount: 0n, pendingLeaseCount: 0n, reservedAmounts: [] },
    balances: [],
    availableBalances: [],
  });
}

function setFaucetResults(mfxSuccess: boolean, pwrSuccess: boolean) {
  vi.mocked(requestFaucetTokens).mockResolvedValue({
    results: [
      { denom: 'umfx', success: mfxSuccess, ...(!mfxSuccess ? { error: 'cooldown' } : {}) },
      { denom: 'factory/addr/upwr', success: pwrSuccess, ...(!pwrSuccess ? { error: 'cooldown' } : {}) },
    ],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(isFaucetEnabled).mockReturnValue(true);
  setBalances(0, 0);
  setCreditBalance(0);
  setFaucetResults(true, true);
  vi.mocked(fundCredit).mockResolvedValue({ success: true, transactionHash: 'hash123', events: [] });
});

afterEach(() => {
  flushSync(() => { root?.unmount(); });
  container?.remove();
  vi.useRealTimers();
});

// ============================================
// First-connect behavior
// ============================================

describe('useAutoRefill — first-connect', () => {
  it('requests faucet tokens for new wallet with zero balance', async () => {
    render(defaultProps());
    await flushMicrotasks();

    expect(getBalance).toHaveBeenCalledWith('manifest1test', 'umfx');
    expect(requestFaucetTokens).toHaveBeenCalledWith('manifest1test');
  });

  it('funds credits after successful faucet', async () => {
    let pwrCallCount = 0;
    vi.mocked(getBalance).mockImplementation(async (_addr: string, denom: string) => {
      if (denom === 'umfx') return { denom, amount: '0' };
      pwrCallCount++;
      return { denom, amount: pwrCallCount <= 1 ? '0' : String(100 * 1_000_000) };
    });

    render(defaultProps());
    await flushMicrotasks();

    expect(fundCredit).toHaveBeenCalledWith(
      expect.anything(),
      'manifest1test',
      'manifest1test',
      { denom: 'factory/addr/upwr', amount: '10000000' },
    );
  });

  it('skips faucet when disabled', async () => {
    vi.mocked(isFaucetEnabled).mockReturnValue(false);

    render(defaultProps());
    await flushMicrotasks();

    expect(getBalance).not.toHaveBeenCalled();
    expect(requestFaucetTokens).not.toHaveBeenCalled();
  });

  it('skips when wallet not connected', async () => {
    render(defaultProps({ isWalletConnected: false, address: undefined }));
    await flushMicrotasks();

    expect(getBalance).not.toHaveBeenCalled();
    expect(requestFaucetTokens).not.toHaveBeenCalled();
  });

  it('logs and toasts on faucet network failure', async () => {
    vi.mocked(getBalance).mockRejectedValue(new Error('network error'));

    render(defaultProps());
    await flushMicrotasks();

    expect(logError).toHaveBeenCalledWith('useAutoRefill.check', expect.any(Error));
  });
});

// ============================================
// Recurring behavior
// ============================================

describe('useAutoRefill — recurring', () => {
  it('runs check immediately on connect, then on interval', async () => {
    setBalances(10, 100);
    setCreditBalance(100);

    render(defaultProps());
    await flushMicrotasks();

    // MFX + PWR queried in parallel (no faucet needed, so no re-query)
    expect(getBalance).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(getBalance).toHaveBeenCalledTimes(2); // Another check
  });

  it('requests faucet when MFX below threshold (non-zero)', async () => {
    // Pre-seed so this is not initial setup (avoids toast suppression)
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(0.3, 100); // MFX below 0.5 threshold

    render(defaultProps());
    await flushMicrotasks();

    expect(requestFaucetTokens).toHaveBeenCalledWith('manifest1test');
  });

  it('requests faucet when PWR below threshold', async () => {
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(10, 3); // PWR below 5 threshold

    render(defaultProps());
    await flushMicrotasks();

    expect(requestFaucetTokens).toHaveBeenCalledWith('manifest1test');
  });

  it('skips faucet when both at exactly threshold', async () => {
    setBalances(0.5, 5); // Exactly at thresholds (uses strict <, so equal should NOT trigger)
    setCreditBalance(100);

    render(defaultProps());
    await flushMicrotasks();

    expect(requestFaucetTokens).not.toHaveBeenCalled();
  });

  it('skips faucet when both above threshold', async () => {
    setBalances(10, 100);
    setCreditBalance(100);

    render(defaultProps());
    await flushMicrotasks();

    expect(requestFaucetTokens).not.toHaveBeenCalled();
  });

  it('auto-funds credits when credit balance low and wallet PWR sufficient', async () => {
    setBalances(10, 100);
    setCreditBalance(2);

    render(defaultProps());
    await flushMicrotasks();

    expect(fundCredit).toHaveBeenCalledWith(
      expect.anything(),
      'manifest1test',
      'manifest1test',
      { denom: 'factory/addr/upwr', amount: '10000000' },
    );
  });

  it('auto-funds credits when wallet PWR exactly at fund amount', async () => {
    setBalances(10, 10); // PWR = 10, threshold uses >= so this should trigger
    setCreditBalance(2);

    render(defaultProps());
    await flushMicrotasks();

    expect(fundCredit).toHaveBeenCalled();
  });

  it('skips fund when credit balance exactly at threshold', async () => {
    setBalances(10, 100);
    setCreditBalance(5); // Exactly at threshold — uses strict <, so should NOT trigger

    render(defaultProps());
    await flushMicrotasks();

    expect(fundCredit).not.toHaveBeenCalled();
  });

  it('skips fund when wallet PWR insufficient', async () => {
    setBalances(10, 5); // PWR = 5, need >= 10 to fund
    setCreditBalance(2);

    render(defaultProps());
    await flushMicrotasks();

    expect(fundCredit).not.toHaveBeenCalled();
  });

  it('treats missing PWR credit entry as zero balance', async () => {
    setBalances(10, 100);
    setEmptyCreditBalance(); // No PWR entry → creditBalance defaults to 0

    render(defaultProps());
    await flushMicrotasks();

    expect(fundCredit).toHaveBeenCalled();
  });

  it('respects faucet 25h cooldown', async () => {
    // Pre-seed so recurring runs show toasts
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(0, 0);
    setCreditBalance(100);

    render(defaultProps());
    await flushMicrotasks();

    expect(requestFaucetTokens).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    setFaucetResults(true, true);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    // Faucet should NOT be called again — cooldown not elapsed
    expect(requestFaucetTokens).not.toHaveBeenCalled();
  });

  it('does not stamp faucet cooldown when all drips fail', async () => {
    // requestFaucetTokens never throws — it converts network/HTTP errors into
    // { success: false } results. All-failed should NOT lock out retries for 25h.
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(0, 0);
    setCreditBalance(100);
    setFaucetResults(false, false);

    render(defaultProps());
    await flushMicrotasks();

    expect(requestFaucetTokens).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();

    // Fix the faucet for next attempt
    setFaucetResults(true, true);

    // Next interval — should retry because cooldown was NOT stamped on all-failed
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(requestFaucetTokens).toHaveBeenCalledTimes(1);
  });

  it('respects fund 5min cooldown', async () => {
    setBalances(10, 100);
    setCreditBalance(2);

    render(defaultProps());
    await flushMicrotasks();

    expect(fundCredit).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();

    // Advance 60s — fund cooldown (5min) not elapsed yet
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(fundCredit).not.toHaveBeenCalled();
  });

  it('re-funds after fund cooldown expires', async () => {
    setBalances(10, 100);
    setCreditBalance(2);

    render(defaultProps());
    await flushMicrotasks();

    expect(fundCredit).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();

    // Advance past 5-minute cooldown + next interval tick
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 60_000);
    await flushMicrotasks();

    expect(fundCredit).toHaveBeenCalledTimes(1);
  });

  it('mutex prevents overlapping checks', async () => {
    let resolveBalance: (() => void) | undefined;
    vi.mocked(getBalance).mockImplementation(
      () => new Promise((resolve) => { resolveBalance = () => resolve({ denom: 'umfx', amount: '0' }); })
    );

    render(defaultProps());
    await flushMicrotasks();

    // First check is still pending (hanging on getBalance) — 2 calls from Promise.all
    const callsAfterFirstCheck = vi.mocked(getBalance).mock.calls.length;
    expect(callsAfterFirstCheck).toBeGreaterThanOrEqual(1);

    // Advance to next interval — should skip because mutex is held
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    // No additional calls — mutex prevented the second check
    expect(getBalance).toHaveBeenCalledTimes(callsAfterFirstCheck);

    // Clean up
    resolveBalance?.();
    await flushMicrotasks();
  });

  it('clears interval on unmount', async () => {
    render(defaultProps());
    await flushMicrotasks();

    vi.clearAllMocks();
    flushSync(() => { root.unmount(); });

    // Advance past interval — should not trigger another check
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(getBalance).not.toHaveBeenCalled();

    // Prevent afterEach from double-unmounting
    container.remove();
    container = document.createElement('div');
    root = createRoot(container);
  });

  it('aborts in-flight check on unmount', async () => {
    // Make getBalance hang so we can unmount while the check is in-flight
    let resolveBalance: ((v: any) => void) | undefined;
    vi.mocked(getBalance).mockImplementation(
      () => new Promise((resolve) => { resolveBalance = resolve; })
    );

    render(defaultProps());
    await flushMicrotasks();

    // Unmount while check is still pending
    flushSync(() => { root.unmount(); });

    // Resolve the hanging balance — abort signal should prevent further action
    resolveBalance?.({ denom: 'umfx', amount: '0' });
    await flushMicrotasks();

    expect(requestFaucetTokens).not.toHaveBeenCalled();
    expect(fundCredit).not.toHaveBeenCalled();

    // Prevent afterEach from double-unmounting
    container.remove();
    container = document.createElement('div');
    root = createRoot(container);
  });

  it('loads persisted cooldowns on address change', async () => {
    // Pre-seed so recurring runs show toasts and respect cooldowns
    saveCooldowns('manifest1second', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(0, 0);
    setCreditBalance(100);

    render(defaultProps({ address: 'manifest1first' }));
    await flushMicrotasks();

    expect(requestFaucetTokens).toHaveBeenCalledWith('manifest1first');
    vi.clearAllMocks();
    setFaucetResults(true, true);

    // Change to address with pre-existing cooldowns
    saveCooldowns('manifest1second', { lastFaucetAttempt: Date.now(), lastFundAttempt: 0 });
    rerender(defaultProps({ address: 'manifest1second' }));
    await flushMicrotasks();

    // Faucet should NOT fire — persisted cooldown is recent
    expect(requestFaucetTokens).not.toHaveBeenCalled();
  });

  it('does not reset cooldowns on re-render with same address', async () => {
    saveCooldowns('manifest1same', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(0, 0);
    setCreditBalance(100);

    render(defaultProps({ address: 'manifest1same' }));
    await flushMicrotasks();

    expect(requestFaucetTokens).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();

    // Disconnect and reconnect same address
    rerender(defaultProps({ isWalletConnected: false, address: undefined }));
    await flushMicrotasks();
    rerender(defaultProps({ address: 'manifest1same' }));
    await flushMicrotasks();

    // Faucet should NOT fire again — cooldown was not reset for same address
    expect(requestFaucetTokens).not.toHaveBeenCalled();
  });

  it('re-checks PWR after faucet before funding', async () => {
    let pwrCallCount = 0;
    vi.mocked(getBalance).mockImplementation(async (_addr: string, denom: string) => {
      if (denom === 'umfx') return { denom, amount: '0' };
      pwrCallCount++;
      return { denom, amount: pwrCallCount <= 1 ? '0' : String(100 * 1_000_000) };
    });
    setCreditBalance(2);

    render(defaultProps());
    await flushMicrotasks();

    expect(fundCredit).toHaveBeenCalled();
  });

  it('skips fund when re-queried PWR after faucet is still insufficient', async () => {
    vi.mocked(getBalance).mockImplementation(async (_addr: string, denom: string) => {
      if (denom === 'umfx') return { denom, amount: '0' };
      return { denom, amount: String(3 * 1_000_000) }; // Always 3 PWR, below 10 threshold
    });
    setCreditBalance(2);

    render(defaultProps());
    await flushMicrotasks();

    expect(requestFaucetTokens).toHaveBeenCalled();
    expect(fundCredit).not.toHaveBeenCalled();
  });

  it('skips PWR re-query when all faucet drips failed', async () => {
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setFaucetResults(false, false); // All fail → faucetRan stays false
    setBalances(0, 100);
    setCreditBalance(2);

    render(defaultProps());
    await flushMicrotasks();

    // Initial 2 calls (MFX + PWR), no re-query since faucetRan is false
    expect(getBalance).toHaveBeenCalledTimes(2);
    // Credits should still be funded using the original PWR balance
    expect(fundCredit).toHaveBeenCalled();
  });

  it('still checks credits when all faucet drips fail', async () => {
    // requestFaucetTokens returns { success: false } on network/HTTP errors — never throws.
    // Credit funding should still proceed using the original wallet PWR balance.
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(0, 100); // Triggers faucet need, but also has enough PWR to fund
    setCreditBalance(2);
    setFaucetResults(false, false);

    render(defaultProps());
    await flushMicrotasks();

    // Credit check should still proceed
    expect(getCreditAccount).toHaveBeenCalled();
    expect(fundCredit).toHaveBeenCalled();
  });

  it('logs error when getCreditAccount throws', async () => {
    setBalances(10, 100);
    vi.mocked(getCreditAccount).mockRejectedValue(new Error('billing module down'));

    render(defaultProps());
    await flushMicrotasks();

    expect(logError).toHaveBeenCalledWith('useAutoRefill.check', expect.any(Error));
    expect(fundCredit).not.toHaveBeenCalled();
  });

  it('falls back to original PWR balance when post-faucet re-query returns invalid string', async () => {
    // Wallet starts with 100 PWR (enough to fund), faucet succeeds, re-query returns garbage
    let pwrCallCount = 0;
    vi.mocked(getBalance).mockImplementation(async (_addr: string, denom: string) => {
      if (denom === 'umfx') return { denom, amount: '0' };
      pwrCallCount++;
      if (pwrCallCount <= 1) return { denom, amount: String(100 * 1_000_000) };
      return { denom, amount: 'garbage' }; // fails /^\d+$/ validation
    });
    setCreditBalance(2);

    render(defaultProps());
    await flushMicrotasks();

    // Should still fund using original 100 PWR balance (invalid string discarded)
    expect(fundCredit).toHaveBeenCalled();
  });

  it('falls back to original PWR balance when post-faucet re-query fails', async () => {
    // Wallet starts with 100 PWR (enough to fund), faucet succeeds, re-query throws
    let pwrCallCount = 0;
    vi.mocked(getBalance).mockImplementation(async (_addr: string, denom: string) => {
      if (denom === 'umfx') return { denom, amount: '0' };
      pwrCallCount++;
      if (pwrCallCount <= 1) return { denom, amount: String(100 * 1_000_000) };
      throw new Error('RPC timeout');
    });
    setCreditBalance(2);

    render(defaultProps());
    await flushMicrotasks();

    expect(logError).toHaveBeenCalledWith('useAutoRefill.pwrRequery', expect.any(Error));
    // Should still fund using original 100 PWR balance
    expect(fundCredit).toHaveBeenCalled();
  });

  it('logs error and bails on invalid balance string', async () => {
    vi.mocked(getBalance).mockResolvedValue({ denom: 'umfx', amount: 'garbage' });

    render(defaultProps());
    await flushMicrotasks();

    expect(logError).toHaveBeenCalledWith('useAutoRefill.check', expect.any(Error));
    expect(requestFaucetTokens).not.toHaveBeenCalled();
  });

  it('logs error and bails on invalid credit balance string', async () => {
    setBalances(10, 100);
    vi.mocked(getCreditAccount).mockResolvedValue({
      creditAccount: { tenant: '', creditAddress: '', activeLeaseCount: 0n, pendingLeaseCount: 0n, reservedAmounts: [] },
      balances: [{ denom: 'factory/addr/upwr', amount: 'garbage' }],
      availableBalances: [],
    });

    render(defaultProps());
    await flushMicrotasks();

    expect(logError).toHaveBeenCalledWith('useAutoRefill.check', expect.any(Error));
    expect(fundCredit).not.toHaveBeenCalled();
  });

  it('re-requests faucet after 25h cooldown expires', async () => {
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(0, 0);
    setCreditBalance(100);

    render(defaultProps());
    await flushMicrotasks();

    expect(requestFaucetTokens).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    setFaucetResults(true, true);

    // Advance past 25h cooldown + next interval tick
    await vi.advanceTimersByTimeAsync(25 * 3600_000 + 60_000);
    await flushMicrotasks();

    expect(requestFaucetTokens).toHaveBeenCalledTimes(1);
  });

  it('bails safely when wallet disconnects mid-check', async () => {
    // Make getBalance hang so we can disconnect while check is in-flight
    let resolveBalance: ((v: any) => void) | undefined;
    vi.mocked(getBalance).mockImplementation(
      () => new Promise((resolve) => { resolveBalance = resolve; })
    );

    render(defaultProps({ address: 'manifest1test' }));
    await flushMicrotasks();

    // Disconnect wallet while check is pending
    rerender(defaultProps({ isWalletConnected: false, address: undefined }));
    await flushMicrotasks();

    // Resolve the hanging balance — stale-address guard should prevent further action
    resolveBalance?.({ denom: 'umfx', amount: '0' });
    await flushMicrotasks();

    expect(requestFaucetTokens).not.toHaveBeenCalled();
    expect(fundCredit).not.toHaveBeenCalled();
  });

  it('old check finally does not steal new address mutex', async () => {
    // Make getBalance for first address hang
    let resolveOld: ((v: any) => void) | undefined;
    vi.mocked(getBalance).mockImplementation(
      () => new Promise((resolve) => { resolveOld = resolve; })
    );

    render(defaultProps({ address: 'manifest1first' }));
    await flushMicrotasks();

    // Switch address — resets mutex, starts new check
    setBalances(10, 100);
    setCreditBalance(100);
    rerender(defaultProps({ address: 'manifest1second' }));
    await flushMicrotasks();

    // New check for second address should have completed
    expect(getCreditAccount).toHaveBeenCalledWith('manifest1second');

    // Now resolve the old hanging check — its finally must NOT steal the mutex
    vi.clearAllMocks();
    resolveOld?.({ denom: 'umfx', amount: '0' });
    await flushMicrotasks();

    // Advance to next interval — if mutex was stolen, this check would be skipped
    setBalances(10, 100);
    setCreditBalance(100);
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    // Should still run the interval check (mutex not stuck)
    expect(getBalance).toHaveBeenCalled();
  });

  it('shows info toast on partial faucet failure (recurring, not initial)', async () => {
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(0, 0);
    setCreditBalance(100);
    setFaucetResults(true, false);

    render(defaultProps());
    await flushMicrotasks();

    expect(mockToast.info).toHaveBeenCalledWith(
      'Some tokens could not be sent — the faucet cooldown may be active.'
    );
  });

  it('shows distinct toast when all faucet requests fail (recurring)', async () => {
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(0, 0);
    setCreditBalance(100);
    setFaucetResults(false, false);

    render(defaultProps());
    await flushMicrotasks();

    expect(mockToast.info).toHaveBeenCalledWith(
      'No tokens could be sent — the faucet cooldown may be active.'
    );
  });

  it('shows info toast when faucet request throws (recurring)', async () => {
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(0, 0);
    vi.mocked(requestFaucetTokens).mockRejectedValue(new Error('faucet down'));

    render(defaultProps());
    await flushMicrotasks();

    expect(logError).toHaveBeenCalledWith('useAutoRefill.faucet', expect.any(Error));
    expect(mockToast.info).toHaveBeenCalledWith(
      'Could not reach the faucet. Will retry automatically.'
    );
  });

  it('shows info toast when fundCredit throws (recurring)', async () => {
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(0, 100);
    vi.mocked(fundCredit).mockRejectedValue(new Error('insufficient funds'));

    render(defaultProps());
    await flushMicrotasks();

    expect(logError).toHaveBeenCalledWith('useAutoRefill.fundCredits', expect.any(Error));
    expect(mockToast.info).toHaveBeenCalledWith(
      'Auto-funding credits failed. You can fund credits manually.'
    );
  });

  it('shows info toast when fundCredit TX fails on-chain (recurring)', async () => {
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(0, 100);
    vi.mocked(fundCredit).mockResolvedValue({ success: false, error: 'account sequence mismatch' });

    render(defaultProps());
    await flushMicrotasks();

    expect(logError).toHaveBeenCalledWith('useAutoRefill.fundCredits', 'account sequence mismatch');
    expect(mockToast.info).toHaveBeenCalledWith(
      'Auto-funding credits failed. You can fund credits manually.'
    );
  });

  it('shows success toast for faucet and fund on recurring runs', async () => {
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    let pwrCallCount = 0;
    vi.mocked(getBalance).mockImplementation(async (_addr: string, denom: string) => {
      if (denom === 'umfx') return { denom, amount: '0' };
      pwrCallCount++;
      return { denom, amount: pwrCallCount <= 1 ? '0' : String(100 * 1_000_000) };
    });
    setCreditBalance(0);

    render(defaultProps());
    await flushMicrotasks();

    expect(mockToast.success).toHaveBeenCalledWith(
      'Free MFX and PWR tokens have been sent to your wallet.'
    );
    expect(mockToast.success).toHaveBeenCalledWith("Funded 10 credits — you're all set!");
  });
});

// ============================================
// Cooldown persistence
// ============================================

describe('useAutoRefill — cooldown persistence', () => {
  it('saves cooldowns after successful faucet', async () => {
    setBalances(0, 0);
    setCreditBalance(100);

    render(defaultProps());
    await flushMicrotasks();

    const persisted = loadCooldowns('manifest1test');
    expect(persisted).not.toBeNull();
    expect(persisted!.lastFaucetAttempt).toBeGreaterThan(0);
  });

  it('saves cooldowns after successful fund', async () => {
    setBalances(10, 100);
    setCreditBalance(2);

    render(defaultProps());
    await flushMicrotasks();

    const persisted = loadCooldowns('manifest1test');
    expect(persisted).not.toBeNull();
    expect(persisted!.lastFundAttempt).toBeGreaterThan(0);
  });

  it('loads persisted cooldowns on mount', async () => {
    // Pre-seed a recent faucet cooldown
    const recentTimestamp = Date.now();
    saveCooldowns('manifest1test', { lastFaucetAttempt: recentTimestamp, lastFundAttempt: 0 });
    setBalances(0, 0);
    setCreditBalance(100);

    render(defaultProps());
    await flushMicrotasks();

    // Faucet should NOT fire — persisted cooldown is recent
    expect(requestFaucetTokens).not.toHaveBeenCalled();
  });

  it('handles corrupted localStorage gracefully', async () => {
    localStorage.setItem('barney-refill-manifest1test', 'not-json');
    setBalances(0, 0);
    setCreditBalance(100);

    render(defaultProps());
    await flushMicrotasks();

    // Should treat as initial setup (no valid cooldowns) and still faucet
    expect(logError).toHaveBeenCalledWith('useAutoRefill.loadCooldowns', expect.any(Error));
    expect(requestFaucetTokens).toHaveBeenCalled();
  });

  it('handles localStorage with invalid shape gracefully', async () => {
    localStorage.setItem('barney-refill-manifest1test', JSON.stringify({ foo: 'bar' }));
    setBalances(0, 0);
    setCreditBalance(100);

    render(defaultProps());
    await flushMicrotasks();

    // Should treat as initial setup (invalid shape) and still faucet
    expect(requestFaucetTokens).toHaveBeenCalled();
  });

  it('always saves cooldowns at end of initial setup', async () => {
    setBalances(10, 100);
    setCreditBalance(100); // No faucet or fund needed

    render(defaultProps());
    await flushMicrotasks();

    // Even though nothing ran, cooldowns should be saved so the key exists
    const persisted = loadCooldowns('manifest1test');
    expect(persisted).not.toBeNull();
  });
});

// ============================================
// Initial setup state
// ============================================

describe('useAutoRefill — initial setup state', () => {
  it('reports isInitialSetup: true for new wallet and dismisses after delay', async () => {
    setBalances(10, 100);
    setCreditBalance(100);

    render(defaultProps());
    // Flush async operations + React state batching
    await flushMicrotasks();
    await flushMicrotasks();

    // After completion, phase should be 'complete' with isInitialSetup still true
    expect(lastSetupState.phase).toBe('complete');
    expect(lastSetupState.isInitialSetup).toBe(true);

    // After delay, isInitialSetup should be false
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(lastSetupState.isInitialSetup).toBe(false);
  });

  it('reports isInitialSetup: false for returning wallet', async () => {
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(10, 100);
    setCreditBalance(100);

    render(defaultProps());
    await flushMicrotasks();

    expect(lastSetupState.isInitialSetup).toBe(false);
  });

  it('suppresses toasts during initial setup', async () => {
    // No pre-seeded cooldowns = initial setup
    setBalances(0, 0);
    setCreditBalance(100);

    render(defaultProps());
    await flushMicrotasks();

    // During initial setup, toasts should NOT be shown
    expect(mockToast.info).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('shows toasts for recurring runs after initial setup', async () => {
    // Seed cooldowns so this is NOT initial setup
    saveCooldowns('manifest1test', { lastFaucetAttempt: 0, lastFundAttempt: 0 });
    setBalances(0, 0);
    setCreditBalance(100);

    render(defaultProps());
    await flushMicrotasks();

    // Should show toasts for recurring runs
    expect(mockToast.info).toHaveBeenCalledWith('Sending free MFX and PWR tokens to your wallet…');
    expect(mockToast.success).toHaveBeenCalledWith(
      'Free MFX and PWR tokens have been sent to your wallet.'
    );
  });

  it('transitions through phases during initial setup', async () => {
    let pwrCallCount = 0;
    vi.mocked(getBalance).mockImplementation(async (_addr: string, denom: string) => {
      if (denom === 'umfx') return { denom, amount: '0' };
      pwrCallCount++;
      return { denom, amount: pwrCallCount <= 1 ? '0' : String(100 * 1_000_000) };
    });
    setCreditBalance(2);

    render(defaultProps());
    // Flush async operations + React state batching
    await flushMicrotasks();
    await flushMicrotasks();

    // After everything completes, should be at 'complete'
    expect(lastSetupState.phase).toBe('complete');
    expect(lastSetupState.isInitialSetup).toBe(true);
  });
});

// ============================================
// loadCooldowns / saveCooldowns unit tests
// ============================================

describe('loadCooldowns / saveCooldowns', () => {
  it('round-trips correctly', () => {
    const data = { lastFaucetAttempt: 12345, lastFundAttempt: 67890 };
    saveCooldowns('manifest1addr', data);
    expect(loadCooldowns('manifest1addr')).toEqual(data);
  });

  it('returns null when key does not exist', () => {
    expect(loadCooldowns('manifest1missing')).toBeNull();
  });

  it('returns null for corrupted JSON', () => {
    localStorage.setItem('barney-refill-manifest1bad', '{invalid');
    expect(loadCooldowns('manifest1bad')).toBeNull();
    expect(logError).toHaveBeenCalledWith('useAutoRefill.loadCooldowns', expect.any(Error));
  });

  it('returns null for JSON with wrong shape', () => {
    localStorage.setItem('barney-refill-manifest1wrong', JSON.stringify({ x: 1 }));
    expect(loadCooldowns('manifest1wrong')).toBeNull();
  });
});
