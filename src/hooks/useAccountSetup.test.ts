import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, type FC, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { useAccountSetup, loadSetupData, saveSetupData, type UseAccountSetupOptions, type AccountSetupState } from './useAccountSetup';

// --- Mocks ---

vi.mock('../api/bank', () => ({
  getBalance: vi.fn(),
}));

vi.mock('../api/billing', () => ({
  getCreditAccount: vi.fn(),
}));

vi.mock('../api/faucet', () => ({
  faucetDripAndVerify: vi.fn(),
  isFaucetEnabled: vi.fn(),
}));

vi.mock('@manifest-network/manifest-sdk/deploy', () => ({
  fundCredits: vi.fn(),
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
import { faucetDripAndVerify, isFaucetEnabled } from '../api/faucet';
import { fundCredits } from '@manifest-network/manifest-sdk/deploy';
import { logError } from '../utils/errors';

// --- Helpers ---

// fundCredits is mocked, so the ctx it receives is ignored — the ref just needs
// a non-null CosmosClientManager to pass the funding-phase readiness guard.
const mockClientManager = {} as any;

/** Wrapper component that calls useAccountSetup with given options and captures state. */
const Wrapper: FC<{ hookProps: UseAccountSetupOptions; onState: (s: AccountSetupState) => void }> = ({ hookProps, onState }) => {
  const state = useAccountSetup(hookProps);
  useEffect(() => { onState(state); });
  return null;
};

function defaultHookProps(overrides?: Partial<UseAccountSetupOptions>): UseAccountSetupOptions {
  return {
    address: 'manifest1abc',
    isWalletConnected: true,
    clientManagerRef: { current: mockClientManager } as React.RefObject<any>,
    ...overrides,
  };
}

/** Balances sufficient for everything: PWR=20, credits=10.
 *  The early credit check finds credits > 0 and skips setup entirely. */
function mockSufficientBalances() {
  vi.mocked(getBalance)
    .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' }); // PWR initial
  vi.mocked(getCreditAccount).mockResolvedValueOnce({
    balances: [{ denom: 'factory/addr/upwr', amount: '10000000' }],
  } as any); // early credit check → credits > 0 → skip
}

/** PWR balance zero — needs faucet + funding */
function mockZeroBalances() {
  vi.mocked(getBalance)
    .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '0' });
}

let container: HTMLDivElement;
let root: Root;
let capturedState: AccountSetupState;
let stateHistory: AccountSetupState[];

function renderHook(props: UseAccountSetupOptions) {
  stateHistory = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root.render(createElement(Wrapper, {
      hookProps: props,
      onState: (s) => {
        capturedState = s;
        stateHistory.push({ ...s });
      },
    }));
  });
}

/** Run all pending timers + microtasks to completion. */
async function flush() {
  await vi.runAllTimersAsync();
  await vi.advanceTimersByTimeAsync(0);
}

/** Check if any state in the history matched a predicate. */
function hadState(predicate: (s: AccountSetupState) => boolean): boolean {
  return stateHistory.some(predicate);
}

beforeEach(() => {
  vi.resetAllMocks(); // resetAllMocks (not clearAllMocks) to clear mockResolvedValueOnce queues between tests
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  vi.mocked(isFaucetEnabled).mockReturnValue(true);
  capturedState = { isInitialSetup: false, phase: 'checking' };
});

afterEach(() => {
  flushSync(() => { root?.unmount(); });
  container?.remove();
  vi.useRealTimers();
});

// ============================================
// Guard conditions
// ============================================

describe('useAccountSetup — guards', () => {
  it('returns initial state when faucet is disabled', async () => {
    vi.mocked(isFaucetEnabled).mockReturnValue(false);
    renderHook(defaultHookProps());
    await flush();
    expect(capturedState).toEqual({ isInitialSetup: false, phase: 'checking' });
    expect(getBalance).not.toHaveBeenCalled();
  });

  it('returns initial state when wallet is not connected', async () => {
    renderHook(defaultHookProps({ isWalletConnected: false }));
    await flush();
    expect(capturedState).toEqual({ isInitialSetup: false, phase: 'checking' });
    expect(getBalance).not.toHaveBeenCalled();
  });

  it('returns initial state when address is undefined', async () => {
    renderHook(defaultHookProps({ address: undefined }));
    await flush();
    expect(capturedState).toEqual({ isInitialSetup: false, phase: 'checking' });
    expect(getBalance).not.toHaveBeenCalled();
  });
});

// ============================================
// Happy path — all steps succeed
// ============================================

describe('useAccountSetup — happy path', () => {
  it('runs full pipeline when PWR balance is zero', async () => {
    mockZeroBalances();
    vi.mocked(getCreditAccount)
      .mockResolvedValueOnce({ balances: [] } as any)  // early credit check: no credits
      .mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any); // funding phase
    vi.mocked(faucetDripAndVerify).mockResolvedValue({ denom: 'factory/addr/upwr', success: true });
    // After faucet: fresh PWR=20
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(fundCredits).mockResolvedValueOnce({ code: 0 } as any);

    renderHook(defaultHookProps());
    await flush();

    expect(faucetDripAndVerify).toHaveBeenCalledTimes(1); // PWR only
    expect(fundCredits).toHaveBeenCalledTimes(1);

    // ENG-312 round-2 units guard: fundCredits forwards `amount` verbatim into
    // the billing fund-credit TX, whose parseAmount requires a <number><denom>
    // coin string — a bare micro-digit string throws "Missing denomination".
    // Pin the denom-suffixed shape + the ENG-565 credit amount (5 PWR, below the
    // faucet drip so PWR remains for gas).
    expect(fundCredits).toHaveBeenCalledWith(
      expect.objectContaining({ chain: mockClientManager }),
      { amount: '5000000factory/addr/upwr' },
    );

    // Went through complete phase and then dismissed
    expect(hadState((s) => s.isInitialSetup && s.phase === 'complete')).toBe(true);
    expect(capturedState.isInitialSetup).toBe(false);

    // Storage saved as completed
    const stored = loadSetupData('manifest1abc');
    expect(stored?.setupCompleted).toBe(true);
  });
});

// ============================================
// Sufficient balances — skip faucet/fund
// ============================================

describe('useAccountSetup — sufficient balances', () => {
  it('skips faucet and funding when balances are sufficient', async () => {
    mockSufficientBalances();

    renderHook(defaultHookProps());
    await flush();

    expect(faucetDripAndVerify).not.toHaveBeenCalled();
    expect(fundCredits).not.toHaveBeenCalled();
    expect(hadState((s) => s.phase === 'complete')).toBe(true);

    const stored = loadSetupData('manifest1abc');
    expect(stored?.setupCompleted).toBe(true);
  });

  it('skips setup on new device when credits are already funded (no localStorage)', async () => {
    // No localStorage — simulates connecting an initialized account on a new device
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount).mockResolvedValueOnce({
      balances: [{ denom: 'factory/addr/upwr', amount: '10000000' }],
    } as any);

    renderHook(defaultHookProps());
    await flush();

    // Should never show the overlay
    expect(hadState((s) => s.isInitialSetup)).toBe(false);
    expect(faucetDripAndVerify).not.toHaveBeenCalled();
    expect(fundCredits).not.toHaveBeenCalled();
    // Should persist setupCompleted for future visits
    expect(loadSetupData('manifest1abc')?.setupCompleted).toBe(true);
  });

  it('proceeds with normal setup when early credit check throws', async () => {
    mockZeroBalances();
    vi.mocked(getCreditAccount)
      .mockRejectedValueOnce(new Error('network error'))  // early check throws
      .mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any); // funding phase
    vi.mocked(faucetDripAndVerify).mockResolvedValue({ denom: 'factory/addr/upwr', success: true });
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(fundCredits).mockResolvedValueOnce({ code: 0 } as any);

    renderHook(defaultHookProps());
    await flush();

    // Full pipeline ran despite early credit check failure
    expect(faucetDripAndVerify).toHaveBeenCalledTimes(1); // PWR only
    expect(fundCredits).toHaveBeenCalledTimes(1);
    expect(hadState((s) => s.isInitialSetup && s.phase === 'complete')).toBe(true);
    expect(capturedState.isInitialSetup).toBe(false);
    expect(loadSetupData('manifest1abc')?.setupCompleted).toBe(true);
  });

  it('skips faucet but funds credits when only credits are low', async () => {
    // PWR=20 — above threshold
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount)
      .mockResolvedValueOnce({ balances: [] } as any)  // early credit check: no credits
      .mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any); // funding phase
    // Fresh PWR re-query
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(fundCredits).mockResolvedValueOnce({ code: 0 } as any);

    renderHook(defaultHookProps());
    await flush();

    expect(faucetDripAndVerify).not.toHaveBeenCalled();
    expect(fundCredits).toHaveBeenCalledTimes(1);
  });
});

// ============================================
// Returning wallet — skip setup
// ============================================

describe('useAccountSetup — returning wallet', () => {
  it('skips setup when storage indicates completed and PWR balance is non-zero', async () => {
    saveSetupData('manifest1abc', { setupCompleted: true });
    // Must mock PWR balance for stale-key check
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });

    renderHook(defaultHookProps());
    await flush();

    expect(capturedState.isInitialSetup).toBe(false);
    expect(faucetDripAndVerify).not.toHaveBeenCalled();
    expect(fundCredits).not.toHaveBeenCalled();
  });
});

// ============================================
// Stale-key detection
// ============================================

describe('useAccountSetup — stale-key detection', () => {
  it('re-runs setup when stored as completed but PWR balance is zero (backend reset)', async () => {
    saveSetupData('manifest1abc', { setupCompleted: true });

    // Initial PWR: zero (stale)
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '0' });
    vi.mocked(getCreditAccount)
      .mockResolvedValueOnce({ balances: [] } as any)  // early credit check: no credits
      .mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any); // funding phase
    // Faucet succeeds
    vi.mocked(faucetDripAndVerify).mockResolvedValue({ denom: 'factory/addr/upwr', success: true });
    // Fresh PWR=20
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(fundCredits).mockResolvedValueOnce({ code: 0 } as any);

    renderHook(defaultHookProps());
    await flush();

    expect(faucetDripAndVerify).toHaveBeenCalled();
    expect(hadState((s) => s.phase === 'complete')).toBe(true);
  });
});

// ============================================
// Retry logic
// ============================================

describe('useAccountSetup — retry', () => {
  it('retries fund credits once on failure', async () => {
    // PWR above faucet threshold
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount)
      .mockResolvedValueOnce({ balances: [] } as any)  // early credit check
      .mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any); // funding phase
    // Fresh PWR
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(fundCredits)
      .mockResolvedValueOnce({ code: 1, rawLog: 'sequence mismatch' } as any)
      .mockResolvedValueOnce({ code: 0 } as any);

    renderHook(defaultHookProps());
    await flush();

    expect(fundCredits).toHaveBeenCalledTimes(2);
    expect(hadState((s) => s.phase === 'complete')).toBe(true);
  });

  it('shows error when funding fails both attempts', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount)
      .mockResolvedValueOnce({ balances: [] } as any)  // early credit check
      .mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any); // funding phase
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(fundCredits)
      .mockResolvedValueOnce({ code: 1, rawLog: 'fail1' } as any)
      .mockResolvedValueOnce({ code: 1, rawLog: 'fail2' } as any);

    renderHook(defaultHookProps());
    await flush();

    expect(fundCredits).toHaveBeenCalledTimes(2);
    expect(hadState((s) => s.phase === 'funding' && !!s.error && s.error.includes('credits'))).toBe(true);
    const stored = loadSetupData('manifest1abc');
    expect(stored?.setupCompleted).toBe(false);
  });

  it('retries PWR faucet once on failure then succeeds', async () => {
    mockZeroBalances();
    vi.mocked(getCreditAccount)
      .mockResolvedValueOnce({ balances: [] } as any)  // early credit check
      .mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '10000000' }] } as any); // funding phase
    vi.mocked(faucetDripAndVerify)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', success: false, error: 'timeout' }) // PWR fail
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', success: true });                    // PWR retry ok
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });

    renderHook(defaultHookProps());
    await flush();

    expect(faucetDripAndVerify).toHaveBeenCalledTimes(2);
    expect(hadState((s) => s.phase === 'complete')).toBe(true);
    expect(loadSetupData('manifest1abc')?.setupCompleted).toBe(true);
  });

  it('stops on PWR faucet failure after retry', async () => {
    mockZeroBalances();
    vi.mocked(getCreditAccount).mockResolvedValueOnce({ balances: [] } as any); // early credit check
    vi.mocked(faucetDripAndVerify)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', success: false, error: 'timeout' }) // PWR fail
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', success: false, error: 'timeout' }); // PWR retry fail

    renderHook(defaultHookProps());
    await flush();

    expect(faucetDripAndVerify).toHaveBeenCalledTimes(2);
    expect(hadState((s) => s.phase === 'faucet' && !!s.error && s.error.includes('starter funds'))).toBe(true);
    expect(loadSetupData('manifest1abc')?.setupCompleted).toBe(false);
  });

  it('retries fund credits when first attempt throws', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount)
      .mockResolvedValueOnce({ balances: [] } as any)  // early credit check
      .mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any); // funding phase
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(fundCredits)
      .mockRejectedValueOnce(new Error('signer error'))
      .mockResolvedValueOnce({ code: 0 } as any);

    renderHook(defaultHookProps());
    await flush();

    expect(fundCredits).toHaveBeenCalledTimes(2);
    expect(hadState((s) => s.phase === 'complete')).toBe(true);
    expect(loadSetupData('manifest1abc')?.setupCompleted).toBe(true);
  });

  it('shows error when fund credits throws on both attempts', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount)
      .mockResolvedValueOnce({ balances: [] } as any)  // early credit check
      .mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any); // funding phase
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(fundCredits)
      .mockRejectedValueOnce(new Error('signer error'))
      .mockRejectedValueOnce(new Error('signer error again'));

    renderHook(defaultHookProps());
    await flush();

    expect(fundCredits).toHaveBeenCalledTimes(2);
    expect(hadState((s) => s.phase === 'funding' && !!s.error && s.error.includes('credits'))).toBe(true);
    expect(loadSetupData('manifest1abc')?.setupCompleted).toBe(false);
  });

  it('shows error when PWR insufficient for credits + gas reserve', async () => {
    // ENG-565: PWR=5 equals the credit amount (5) but is below credit + gas
    // reserve (6), so funding the full credit would overdraw once gas is deducted
    // from the same PWR balance — the guard must fail cleanly without broadcasting.
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '5000000' });
    vi.mocked(getCreditAccount)
      .mockResolvedValueOnce({ balances: [] } as any)  // early credit check
      .mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any); // funding phase
    // Fresh PWR re-query
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '5000000' });

    renderHook(defaultHookProps());
    await flush();

    expect(fundCredits).not.toHaveBeenCalled();
    expect(hadState((s) => !!s.error && s.error.includes('Not enough funds'))).toBe(true);
  });
});

// ============================================
// Storage migration
// ============================================

describe('useAccountSetup — storage migration', () => {
  it('migrates v0 format (bare JSON) to v2', () => {
    // V0: no envelope wrapper, just raw data
    localStorage.setItem('barney-refill-manifest1abc', JSON.stringify({
      lastFaucetAttempt: 1000,
      lastFundAttempt: 500,
    }));
    const data = loadSetupData('manifest1abc');
    expect(data).toEqual({ setupCompleted: true });
  });

  it('migrates v1 envelope to v2', () => {
    localStorage.setItem('barney-refill-manifest1abc', JSON.stringify({
      v: 1,
      data: { lastFaucetAttempt: 1000, lastFundAttempt: 500, faucetSucceeded: true },
    }));
    const data = loadSetupData('manifest1abc');
    expect(data).toEqual({ setupCompleted: true });
  });

  it('migrates v0 with lastFaucetAttempt=0 but lastFundAttempt>0 to setupCompleted=true', () => {
    // Edge case: wallet was already funded, faucet was never needed
    localStorage.setItem('barney-refill-manifest1abc', JSON.stringify({
      lastFaucetAttempt: 0,
      lastFundAttempt: 500,
    }));
    const data = loadSetupData('manifest1abc');
    expect(data).toEqual({ setupCompleted: true });
  });

  it('migrates v1 with faucetSucceeded=false to setupCompleted=false', () => {
    localStorage.setItem('barney-refill-manifest1abc', JSON.stringify({
      v: 1,
      data: { lastFaucetAttempt: 0, lastFundAttempt: 0, faucetSucceeded: false },
    }));
    const data = loadSetupData('manifest1abc');
    expect(data).toEqual({ setupCompleted: false });
  });

  it('reads v2 format correctly', () => {
    saveSetupData('manifest1abc', { setupCompleted: true });
    const data = loadSetupData('manifest1abc');
    expect(data).toEqual({ setupCompleted: true });
  });
});

// ============================================
// Cleanup on unmount
// ============================================

describe('useAccountSetup — cleanup', () => {
  it('aborts in-flight operations on unmount', async () => {
    // Set up a slow faucet that will be aborted
    mockZeroBalances();
    vi.mocked(getCreditAccount).mockResolvedValueOnce({ balances: [] } as any); // early credit check
    vi.mocked(faucetDripAndVerify).mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve({ denom: 'factory/addr/upwr', success: true }), 10_000))
    );

    renderHook(defaultHookProps());
    // Unmount quickly before faucet resolves
    flushSync(() => { root.unmount(); });

    // Should not throw or set state after unmount
    await flush();
    // If we get here without errors, cleanup worked
    expect(true).toBe(true);
  });
});

// ============================================
// Error handling
// ============================================

describe('useAccountSetup — error handling', () => {
  it('shows error in overlay for invalid balance format on new wallet', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: 'NaN' });

    renderHook(defaultHookProps());
    await flush();

    expect(logError).toHaveBeenCalledWith('useAccountSetup.check', expect.any(Error));
    expect(hadState((s) => s.isInitialSetup && s.phase === 'checking' && !!s.error && s.error.includes('balances'))).toBe(true);
    expect(loadSetupData('manifest1abc')?.setupCompleted).toBe(false);
  });

  it('shows error in overlay when getBalance throws on new wallet', async () => {
    vi.mocked(getBalance).mockRejectedValue(new Error('network error'));

    renderHook(defaultHookProps());
    await flush();

    expect(logError).toHaveBeenCalledWith('useAccountSetup.run', expect.any(Error));
    expect(hadState((s) => s.isInitialSetup && s.phase === 'checking' && !!s.error && s.error.includes('wrong'))).toBe(true);
    expect(loadSetupData('manifest1abc')?.setupCompleted).toBe(false);
  });

  it('does not flash overlay for returning wallet with invalid balance format', async () => {
    saveSetupData('manifest1abc', { setupCompleted: true });
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: 'garbage' });

    renderHook(defaultHookProps());
    await flush();

    expect(logError).toHaveBeenCalledWith('useAccountSetup.check', expect.any(Error));
    // Should never show overlay for returning wallet
    expect(hadState((s) => s.isInitialSetup)).toBe(false);
  });

  it('logs invalid fresh PWR balance format', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount)
      .mockResolvedValueOnce({ balances: [] } as any)  // early credit check
      .mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '10000000' }] } as any); // funding phase
    // Fresh PWR re-query returns garbage
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: 'bad' });

    renderHook(defaultHookProps());
    await flush();

    expect(logError).toHaveBeenCalledWith('useAccountSetup.freshPwr', expect.any(Error));
  });

  it('logs invalid credit balance format', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount)
      .mockResolvedValueOnce({ balances: [] } as any)  // early credit check
      .mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: 'NaN' }] } as any); // funding phase: invalid format
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    // Credit balance defaults to 0, so funding will be attempted
    vi.mocked(fundCredits).mockResolvedValueOnce({ code: 0 } as any);

    renderHook(defaultHookProps());
    await flush();

    expect(logError).toHaveBeenCalledWith('useAccountSetup.creditBalance', expect.any(Error));
  });
});
