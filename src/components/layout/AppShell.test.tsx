import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { AppShell } from './AppShell';

// --- Mocks ---

const mockSetClientManager = vi.fn();
const mockSetAddress = vi.fn();
const mockSetSignArbitrary = vi.fn();

vi.mock('../../hooks/useAI', () => ({
  useAI: () => ({
    setClientManager: mockSetClientManager,
    setAddress: mockSetAddress,
    setSignArbitrary: mockSetSignArbitrary,
  }),
}));

let mockIsWalletConnected = false;
let mockAddress: string | undefined;

vi.mock('../../hooks/useManifestMCP', () => ({
  useManifestMCP: () => ({
    clientManager: null,
    address: mockAddress,
  }),
}));

const mockGetOfflineSigner = vi.fn().mockReturnValue({ getAccounts: vi.fn() });

vi.mock('@cosmos-kit/react', () => ({
  useChain: () => ({
    signArbitrary: vi.fn(),
    isWalletConnected: mockIsWalletConnected,
    isWalletConnecting: false,
    openView: vi.fn(),
    getOfflineSigner: mockGetOfflineSigner,
  }),
}));

const mockToast = { success: vi.fn(), info: vi.fn(), error: vi.fn() };
vi.mock('../../hooks/useToast', () => ({
  useToast: () => mockToast,
}));

vi.mock('../../config/chain', () => ({
  CHAIN_NAME: 'manifestlocal',
}));

vi.mock('../landing/LandingPage', () => ({
  LandingPage: () => createElement('div', { 'data-testid': 'landing' }),
}));

vi.mock('./MainLayout', () => ({
  MainLayout: () => createElement('div', { 'data-testid': 'main-layout' }),
}));

vi.mock('../../api/bank', () => ({
  getBalance: vi.fn(),
}));

vi.mock('../../api/faucet', () => ({
  requestFaucetTokens: vi.fn(),
  isFaucetEnabled: vi.fn(),
}));

vi.mock('../../api/tx', () => ({
  fundCredit: vi.fn(),
}));

vi.mock('../../api/config', () => ({
  DENOMS: { MFX: 'umfx', PWR: 'factory/addr/upwr' },
}));

vi.mock('../../utils/format', () => ({
  toBaseUnits: (amount: number) => String(amount * 1_000_000),
}));

vi.mock('../../utils/errors', () => ({
  logError: vi.fn(),
}));

import { getBalance } from '../../api/bank';
import { requestFaucetTokens, isFaucetEnabled } from '../../api/faucet';
import { fundCredit } from '../../api/tx';
import { logError } from '../../utils/errors';

// --- Helpers ---

let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => { root.render(createElement(AppShell)); });
}

/** Flush microtasks so async IIFE in useEffect completes. */
async function flushAsync() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsWalletConnected = false;
  mockAddress = undefined;
  vi.mocked(isFaucetEnabled).mockReturnValue(true);
  vi.mocked(getBalance).mockResolvedValue({ denom: 'umfx', amount: '0' });
  vi.mocked(requestFaucetTokens).mockResolvedValue({
    results: [
      { denom: 'umfx', success: true },
      { denom: 'factory/addr/upwr', success: true },
    ],
  });
  vi.mocked(fundCredit).mockResolvedValue({ success: true, transactionHash: 'hash123', events: [] });
});

afterEach(() => {
  flushSync(() => { root?.unmount(); });
  container?.remove();
});

describe('AppShell auto-faucet', () => {
  it('requests faucet tokens for new wallet with zero balance', async () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1new';

    render();
    await flushAsync();

    expect(getBalance).toHaveBeenCalledWith('manifest1new', 'umfx');
    expect(requestFaucetTokens).toHaveBeenCalledWith('manifest1new');
    expect(mockToast.success).toHaveBeenCalledWith(
      'Welcome! Free MFX and PWR tokens have been sent to your wallet.'
    );
  });

  it('skips faucet for returning user with nonzero balance', async () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1rich';
    vi.mocked(getBalance).mockResolvedValue({ denom: 'umfx', amount: '5000000' });

    render();
    await flushAsync();

    expect(getBalance).toHaveBeenCalled();
    expect(requestFaucetTokens).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('does not request faucet when disabled', async () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1new';
    vi.mocked(isFaucetEnabled).mockReturnValue(false);

    render();
    await flushAsync();

    expect(getBalance).not.toHaveBeenCalled();
    expect(requestFaucetTokens).not.toHaveBeenCalled();
  });

  it('shows info toast on partial faucet failure', async () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1new';
    vi.mocked(requestFaucetTokens).mockResolvedValue({
      results: [
        { denom: 'umfx', success: true },
        { denom: 'factory/addr/upwr', success: false, error: 'cooldown active' },
      ],
    });

    render();
    await flushAsync();

    expect(mockToast.info).toHaveBeenCalledWith(
      'Welcome! Some tokens could not be sent — the 24h cooldown may be active.'
    );
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('does not duplicate faucet request on re-render with same address', async () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1new';

    render();
    await flushAsync();

    expect(requestFaucetTokens).toHaveBeenCalledTimes(1);

    // Re-render (simulating deps change triggering effect again)
    flushSync(() => { root.render(createElement(AppShell)); });
    await flushAsync();

    // Should still be 1 call — ref guard prevents duplicate
    expect(requestFaucetTokens).toHaveBeenCalledTimes(1);
  });

  it('requests faucet again when wallet address changes', async () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1new';

    render();
    await flushAsync();

    expect(requestFaucetTokens).toHaveBeenCalledTimes(1);

    // Change address and re-render — should trigger a new faucet request
    mockAddress = 'manifest1other';
    flushSync(() => { root.render(createElement(AppShell)); });
    await flushAsync();

    expect(requestFaucetTokens).toHaveBeenCalledTimes(2);
    expect(requestFaucetTokens).toHaveBeenLastCalledWith('manifest1other');
  });

  it('silently logs errors without showing toast', async () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1new';
    vi.mocked(getBalance).mockRejectedValue(new Error('network error'));

    render();
    await flushAsync();

    expect(logError).toHaveBeenCalledWith('AppShell.autoFaucet', expect.any(Error));
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.info).not.toHaveBeenCalled();
  });

  it('shows distinct toast when all faucet requests fail', async () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1new';
    vi.mocked(requestFaucetTokens).mockResolvedValue({
      results: [
        { denom: 'umfx', success: false, error: 'cooldown active' },
        { denom: 'factory/addr/upwr', success: false, error: 'cooldown active' },
      ],
    });

    render();
    await flushAsync();

    expect(mockToast.info).toHaveBeenCalledWith(
      'Welcome! No tokens could be sent — the 24h cooldown may be active.'
    );
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('does not request faucet when wallet is not connected', async () => {
    mockIsWalletConnected = false;
    mockAddress = undefined;

    render();
    await flushAsync();

    expect(getBalance).not.toHaveBeenCalled();
    expect(requestFaucetTokens).not.toHaveBeenCalled();
  });
});

describe('AppShell auto-fund credits', () => {
  it('funds credit account after successful faucet', async () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1new';

    render();
    await flushAsync();

    expect(fundCredit).toHaveBeenCalledWith(
      expect.anything(), // signer
      'manifest1new',
      'manifest1new',
      { denom: 'factory/addr/upwr', amount: '10000000' },
    );
    expect(mockToast.success).toHaveBeenCalledWith('Funded 10 credits — you\'re all set!');
  });

  it('skips auto-fund when PWR faucet drip fails', async () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1new';
    vi.mocked(requestFaucetTokens).mockResolvedValue({
      results: [
        { denom: 'umfx', success: true },
        { denom: 'factory/addr/upwr', success: false, error: 'cooldown' },
      ],
    });

    render();
    await flushAsync();

    expect(fundCredit).not.toHaveBeenCalled();
  });

  it('shows info toast when fundCredit throws', async () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1new';
    vi.mocked(fundCredit).mockRejectedValue(new Error('insufficient funds'));

    render();
    await flushAsync();

    expect(logError).toHaveBeenCalledWith('AppShell.autoFundCredits', expect.any(Error));
    // Faucet success toast should still appear
    expect(mockToast.success).toHaveBeenCalledWith(
      'Welcome! Free MFX and PWR tokens have been sent to your wallet.'
    );
    // User informed about fund failure
    expect(mockToast.info).toHaveBeenCalledWith(
      'Tokens received, but auto-funding credits failed. You can fund credits manually.'
    );
  });

  it('shows info toast when fundCredit TX fails on-chain', async () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1new';
    vi.mocked(fundCredit).mockResolvedValue({
      success: false,
      error: 'account sequence mismatch',
    });

    render();
    await flushAsync();

    expect(logError).toHaveBeenCalledWith('AppShell.autoFundCredits', 'account sequence mismatch');
    expect(mockToast.info).toHaveBeenCalledWith(
      'Tokens received, but auto-funding credits failed. You can fund credits manually.'
    );
  });

  it('skips auto-fund for returning users', async () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1rich';
    vi.mocked(getBalance).mockResolvedValue({ denom: 'umfx', amount: '5000000' });

    render();
    await flushAsync();

    expect(fundCredit).not.toHaveBeenCalled();
  });
});
