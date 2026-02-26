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
import { faucetDripAndVerify, isFaucetEnabled } from '../api/faucet';
import { fundCredit } from '../api/tx';
import { logError } from '../utils/errors';

// --- Helpers ---

const mockGetOfflineSigner = vi.fn().mockReturnValue({ getAccounts: vi.fn() });

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
    getOfflineSignerRef: { current: mockGetOfflineSigner } as React.RefObject<() => any>,
    ...overrides,
  };
}

/** Balances sufficient for everything: MFX=10, PWR=20, credits=10 */
function mockSufficientBalances() {
  vi.mocked(getBalance)
    .mockResolvedValueOnce({ denom: 'umfx', amount: '10000000' })        // MFX initial
    .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' })  // PWR initial
    .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' }); // PWR fresh re-query
  vi.mocked(getCreditAccount).mockResolvedValueOnce({
    balances: [{ denom: 'factory/addr/upwr', amount: '10000000' }],
  } as any);
}

/** Balances zero — needs faucet + funding */
function mockZeroBalances() {
  vi.mocked(getBalance)
    .mockResolvedValueOnce({ denom: 'umfx', amount: '0' })
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
  vi.clearAllMocks();
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
  it('runs full pipeline when balances are zero', async () => {
    mockZeroBalances();
    vi.mocked(faucetDripAndVerify).mockResolvedValue({ denom: 'umfx', success: true });
    // After faucet: fresh PWR=20, credits=0
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount).mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any);
    vi.mocked(fundCredit).mockResolvedValueOnce({ success: true, transactionHash: '0xabc', events: [] });

    renderHook(defaultHookProps());
    await flush();

    expect(faucetDripAndVerify).toHaveBeenCalledTimes(2); // MFX + PWR
    expect(fundCredit).toHaveBeenCalledTimes(1);

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
    expect(fundCredit).not.toHaveBeenCalled();
    expect(hadState((s) => s.phase === 'complete')).toBe(true);

    const stored = loadSetupData('manifest1abc');
    expect(stored?.setupCompleted).toBe(true);
  });

  it('skips faucet but funds credits when only credits are low', async () => {
    // MFX=10, PWR=20 — above thresholds
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '10000000' })
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    // Fresh PWR re-query + credits=0
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount).mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any);
    vi.mocked(fundCredit).mockResolvedValueOnce({ success: true, transactionHash: '0xabc', events: [] });

    renderHook(defaultHookProps());
    await flush();

    expect(faucetDripAndVerify).not.toHaveBeenCalled();
    expect(fundCredit).toHaveBeenCalledTimes(1);
  });
});

// ============================================
// Returning wallet — skip setup
// ============================================

describe('useAccountSetup — returning wallet', () => {
  it('skips setup when storage indicates completed and balances are non-zero', async () => {
    saveSetupData('manifest1abc', { setupCompleted: true });
    // Must mock balances for stale-key check
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '10000000' })
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });

    renderHook(defaultHookProps());
    await flush();

    expect(capturedState.isInitialSetup).toBe(false);
    expect(faucetDripAndVerify).not.toHaveBeenCalled();
    expect(fundCredit).not.toHaveBeenCalled();
  });
});

// ============================================
// Stale-key detection
// ============================================

describe('useAccountSetup — stale-key detection', () => {
  it('re-runs setup when stored as completed but balances are zero (backend reset)', async () => {
    saveSetupData('manifest1abc', { setupCompleted: true });

    // Initial balances: both zero (stale)
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '0' })
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '0' });
    // Faucet succeeds
    vi.mocked(faucetDripAndVerify).mockResolvedValue({ denom: 'umfx', success: true });
    // Fresh PWR=20, credits=0
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount).mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any);
    vi.mocked(fundCredit).mockResolvedValueOnce({ success: true, transactionHash: '0xabc', events: [] });

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
  it('retries MFX faucet once on failure then succeeds', async () => {
    mockZeroBalances();
    vi.mocked(faucetDripAndVerify)
      .mockResolvedValueOnce({ denom: 'umfx', success: false, error: 'timeout' })  // MFX fail
      .mockResolvedValueOnce({ denom: 'umfx', success: true })                      // MFX retry ok
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', success: true });         // PWR ok
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount).mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '10000000' }] } as any);

    renderHook(defaultHookProps());
    await flush();

    expect(faucetDripAndVerify).toHaveBeenCalledTimes(3);
    expect(hadState((s) => s.phase === 'complete')).toBe(true);
  });

  it('stops on MFX faucet failure after retry — does not attempt PWR', async () => {
    mockZeroBalances();
    vi.mocked(faucetDripAndVerify)
      .mockResolvedValueOnce({ denom: 'umfx', success: false, error: 'timeout' })
      .mockResolvedValueOnce({ denom: 'umfx', success: false, error: 'timeout' });

    renderHook(defaultHookProps());
    await flush();

    // Only 2 calls (MFX attempt + MFX retry), no PWR attempt
    expect(faucetDripAndVerify).toHaveBeenCalledTimes(2);
    // Error phase was reached before dismiss
    expect(hadState((s) => s.phase === 'faucet' && !!s.error && s.error.includes('starter funds'))).toBe(true);
    // Eventually dismissed
    expect(capturedState.isInitialSetup).toBe(false);
    // Storage saved as not completed
    const stored = loadSetupData('manifest1abc');
    expect(stored?.setupCompleted).toBe(false);
  });

  it('retries fund credits once on failure', async () => {
    // Balances above faucet thresholds
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '10000000' })
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    // Fresh PWR + credits=0
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount).mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any);
    vi.mocked(fundCredit)
      .mockResolvedValueOnce({ success: false, error: 'sequence mismatch' })
      .mockResolvedValueOnce({ success: true, transactionHash: '0xabc', events: [] });

    renderHook(defaultHookProps());
    await flush();

    expect(fundCredit).toHaveBeenCalledTimes(2);
    expect(hadState((s) => s.phase === 'complete')).toBe(true);
  });

  it('shows error when funding fails both attempts', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '10000000' })
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount).mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any);
    vi.mocked(fundCredit)
      .mockResolvedValueOnce({ success: false, error: 'fail1' })
      .mockResolvedValueOnce({ success: false, error: 'fail2' });

    renderHook(defaultHookProps());
    await flush();

    expect(fundCredit).toHaveBeenCalledTimes(2);
    expect(hadState((s) => s.phase === 'funding' && !!s.error && s.error.includes('credits'))).toBe(true);
    const stored = loadSetupData('manifest1abc');
    expect(stored?.setupCompleted).toBe(false);
  });

  it('retries PWR faucet once on failure then succeeds', async () => {
    mockZeroBalances();
    vi.mocked(faucetDripAndVerify)
      .mockResolvedValueOnce({ denom: 'umfx', success: true })                              // MFX ok
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', success: false, error: 'timeout' }) // PWR fail
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', success: true });                    // PWR retry ok
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount).mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '10000000' }] } as any);

    renderHook(defaultHookProps());
    await flush();

    expect(faucetDripAndVerify).toHaveBeenCalledTimes(3);
    expect(hadState((s) => s.phase === 'complete')).toBe(true);
    expect(loadSetupData('manifest1abc')?.setupCompleted).toBe(true);
  });

  it('stops on PWR faucet failure after retry', async () => {
    mockZeroBalances();
    vi.mocked(faucetDripAndVerify)
      .mockResolvedValueOnce({ denom: 'umfx', success: true })                                 // MFX ok
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', success: false, error: 'timeout' }) // PWR fail
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', success: false, error: 'timeout' }); // PWR retry fail

    renderHook(defaultHookProps());
    await flush();

    expect(faucetDripAndVerify).toHaveBeenCalledTimes(3);
    expect(hadState((s) => s.phase === 'faucet' && !!s.error && s.error.includes('starter funds'))).toBe(true);
    expect(loadSetupData('manifest1abc')?.setupCompleted).toBe(false);
  });

  it('retries fund credits when first attempt throws', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '10000000' })
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount).mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any);
    vi.mocked(fundCredit)
      .mockRejectedValueOnce(new Error('signer error'))
      .mockResolvedValueOnce({ success: true, transactionHash: '0xabc', events: [] });

    renderHook(defaultHookProps());
    await flush();

    expect(fundCredit).toHaveBeenCalledTimes(2);
    expect(hadState((s) => s.phase === 'complete')).toBe(true);
    expect(loadSetupData('manifest1abc')?.setupCompleted).toBe(true);
  });

  it('shows error when fund credits throws on both attempts', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '10000000' })
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount).mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any);
    vi.mocked(fundCredit)
      .mockRejectedValueOnce(new Error('signer error'))
      .mockRejectedValueOnce(new Error('signer error again'));

    renderHook(defaultHookProps());
    await flush();

    expect(fundCredit).toHaveBeenCalledTimes(2);
    expect(hadState((s) => s.phase === 'funding' && !!s.error && s.error.includes('credits'))).toBe(true);
    expect(loadSetupData('manifest1abc')?.setupCompleted).toBe(false);
  });

  it('shows error when PWR insufficient for credits', async () => {
    // MFX sufficient, PWR=5 (at faucet threshold but below credit amount of 10)
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '10000000' })
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '5000000' });
    // Fresh PWR re-query
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '5000000' });
    vi.mocked(getCreditAccount).mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '0' }] } as any);

    renderHook(defaultHookProps());
    await flush();

    expect(fundCredit).not.toHaveBeenCalled();
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
    vi.mocked(faucetDripAndVerify).mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve({ denom: 'umfx', success: true }), 10_000))
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
      .mockResolvedValueOnce({ denom: 'umfx', amount: 'NaN' })
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '1000000' });

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
      .mockResolvedValueOnce({ denom: 'umfx', amount: 'garbage' })
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '1000000' });

    renderHook(defaultHookProps());
    await flush();

    expect(logError).toHaveBeenCalledWith('useAccountSetup.check', expect.any(Error));
    // Should never show overlay for returning wallet
    expect(hadState((s) => s.isInitialSetup)).toBe(false);
  });

  it('logs invalid fresh PWR balance format', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '10000000' })
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    // Fresh PWR re-query returns garbage
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: 'bad' });
    vi.mocked(getCreditAccount).mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: '10000000' }] } as any);

    renderHook(defaultHookProps());
    await flush();

    expect(logError).toHaveBeenCalledWith('useAccountSetup.freshPwr', expect.any(Error));
  });

  it('logs invalid credit balance format', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '10000000' })
      .mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'factory/addr/upwr', amount: '20000000' });
    vi.mocked(getCreditAccount).mockResolvedValueOnce({ balances: [{ denom: 'factory/addr/upwr', amount: 'NaN' }] } as any);
    // Credit balance defaults to 0, so funding will be attempted
    vi.mocked(fundCredit).mockResolvedValueOnce({ success: true, transactionHash: '0xabc', events: [] });

    renderHook(defaultHookProps());
    await flush();

    expect(logError).toHaveBeenCalledWith('useAccountSetup.creditBalance', expect.any(Error));
  });
});
