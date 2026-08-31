import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AI_TOOL_API_TIMEOUT_MS } from '../../config/constants';

const mocks = vi.hoisted(() => ({
  address: 'manifest1walleta' as string | undefined,
  disconnect: vi.fn(),
  sendMessage: vi.fn(),
  attachPayload: vi.fn(),
  getApps: vi.fn(),
  subscribeToRegistry: vi.fn(),
  getCreditAccount: vi.fn(),
  getCreditEstimate: vi.fn(),
  useVisibilityPolling: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@cosmos-kit/react', () => ({
  useChain: () => ({
    address: mocks.address,
    disconnect: mocks.disconnect,
    wallet: { prettyName: 'Test Wallet' },
  }),
}));

vi.mock('../../hooks/useAI', () => ({
  useAI: () => ({
    sendMessage: mocks.sendMessage,
    attachPayload: mocks.attachPayload,
    dnsStatuses: new Map(),
  }),
}));

vi.mock('../../hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({
    copyToClipboard: vi.fn(),
    isCopied: () => false,
  }),
}));

vi.mock('../../registry/appRegistry', () => ({
  getApps: mocks.getApps,
  subscribeToRegistry: mocks.subscribeToRegistry,
}));

vi.mock('../../api/billing', () => ({
  LeaseState: {
    LEASE_STATE_UNSPECIFIED: 0,
    LEASE_STATE_PENDING: 1,
    LEASE_STATE_ACTIVE: 2,
    LEASE_STATE_CLOSED: 3,
    LEASE_STATE_REJECTED: 4,
    LEASE_STATE_EXPIRED: 5,
    UNRECOGNIZED: -1,
  },
  getCreditAccount: mocks.getCreditAccount,
  getCreditEstimate: mocks.getCreditEstimate,
}));

vi.mock('../../hooks/useVisibilityPolling', () => ({
  useVisibilityPolling: mocks.useVisibilityPolling,
}));

vi.mock('../../utils/format', () => ({
  fromBaseUnits: (amount: string) => Number(amount) / 1_000_000,
  timeAgo: () => 'just now',
}));

vi.mock('../../utils/errors', () => ({ logError: mocks.logError }));

import { AppsSidebar } from './AppsSidebar';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function creditAccount(pwr: number) {
  return {
    balances: [{ denom: 'upwr', amount: String(pwr * 1_000_000) }],
  };
}

function creditEstimate(hours: number, ratePerSecond = 0.001) {
  return {
    totalRatePerSecond: [{ denom: 'upwr', amount: String(ratePerSecond * 1_000_000) }],
    estimatedDurationSeconds: BigInt(hours * 3_600),
  };
}

describe('AppsSidebar refresh lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.address = 'manifest1walleta';
    mocks.getApps.mockReturnValue([]);
    mocks.subscribeToRegistry.mockReturnValue(() => undefined);
    mocks.getCreditAccount.mockResolvedValue(creditAccount(0));
    mocks.getCreditEstimate.mockResolvedValue(null);
    mocks.disconnect.mockResolvedValue(undefined);
    mocks.attachPayload.mockResolvedValue({});
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(): Promise<void> {
    await act(async () => {
      root.render(createElement(AppsSidebar));
    });
  }

  function latestRefresh(): () => Promise<boolean | void> {
    const call = mocks.useVisibilityPolling.mock.calls.at(-1);
    expect(call).toBeDefined();
    return call![0];
  }

  it('routes initial and wallet-change refreshes through a restartable poller', async () => {
    await render();

    expect(mocks.getApps).not.toHaveBeenCalled();
    expect(mocks.getCreditAccount).not.toHaveBeenCalled();
    expect(mocks.getCreditEstimate).not.toHaveBeenCalled();
    expect(mocks.useVisibilityPolling).toHaveBeenLastCalledWith(
      expect.any(Function),
      15_000,
      expect.objectContaining({
        enabled: true,
        immediate: true,
        backoff: true,
        restartKey: 'manifest1walleta',
      }),
    );

    mocks.address = 'manifest1walletb';
    await render();

    expect(mocks.getApps).not.toHaveBeenCalled();
    expect(mocks.useVisibilityPolling).toHaveBeenLastCalledWith(
      expect.any(Function),
      15_000,
      expect.objectContaining({ restartKey: 'manifest1walletb' }),
    );
  });

  it('settles after stalled credit-read deadlines', async () => {
    vi.useFakeTimers();
    mocks.getCreditAccount.mockImplementation(() => new Promise(() => undefined));
    mocks.getCreditEstimate.mockImplementation(() => new Promise(() => undefined));
    await render();

    let stalled!: Promise<boolean | void>;
    act(() => {
      stalled = latestRefresh()();
    });
    let settled = false;
    void stalled.then(() => { settled = true; });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS + 1);
    });

    expect(settled).toBe(true);
    await stalled;
    expect(mocks.logError).toHaveBeenCalledWith(
      'AppsSidebar.refresh.credits',
      expect.objectContaining({ message: expect.stringContaining('timed out') }),
    );
    expect(mocks.logError).toHaveBeenCalledWith(
      'AppsSidebar.refresh.estimate',
      expect.objectContaining({ message: expect.stringContaining('timed out') }),
    );

    mocks.getCreditAccount.mockResolvedValue(creditAccount(7));
    mocks.getCreditEstimate.mockResolvedValue(null);
    await act(async () => {
      await latestRefresh()();
    });
    expect(container.textContent).toContain('7 PWR');
  });

  it('hides wallet A credit data immediately when wallet B reads fail', async () => {
    mocks.getCreditAccount.mockResolvedValue(creditAccount(5));
    mocks.getCreditEstimate.mockResolvedValue(creditEstimate(2));
    await render();
    await act(async () => {
      await latestRefresh()();
    });
    expect(container.textContent).toContain('5 PWR');
    expect(container.textContent).toContain('~2h remaining');

    mocks.address = 'manifest1walletb';
    mocks.getCreditAccount.mockRejectedValue(new Error('account unavailable'));
    mocks.getCreditEstimate.mockRejectedValue(new Error('estimate unavailable'));
    await render();

    expect(container.querySelector('.apps-sidebar__credits-amount')?.textContent).toBe('--');
    expect(container.textContent).not.toContain('5 PWR');
    expect(container.textContent).not.toContain('~2h remaining');

    await act(async () => {
      await expect(latestRefresh()()).resolves.toBe(false);
    });
    expect(container.querySelector('.apps-sidebar__credits-amount')?.textContent).toBe('--');
    expect(container.textContent).not.toContain('5 PWR');
    expect(container.textContent).not.toContain('~2h remaining');
    expect(container.textContent).toContain('Couldn’t load credit details.');

    const accountCallsBeforeRetry = mocks.getCreditAccount.mock.calls.length;
    const retryButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry',
    );
    expect(retryButton).toBeDefined();
    await act(async () => {
      retryButton?.click();
    });
    expect(mocks.getCreditAccount).toHaveBeenCalledTimes(accountCallsBeforeRetry);
    expect(mocks.useVisibilityPolling).toHaveBeenLastCalledWith(
      expect.any(Function),
      15_000,
      expect.objectContaining({ restartKey: 'manifest1walletb:1' }),
    );

    // Returning to A creates a new wallet lifecycle; do not resurrect the
    // snapshot from A's earlier session before this lifecycle refreshes.
    mocks.address = 'manifest1walleta';
    await render();
    expect(container.querySelector('.apps-sidebar__credits-amount')?.textContent).toBe('--');
    expect(container.textContent).not.toContain('5 PWR');
    expect(container.textContent).not.toContain('Couldn’t load credit details.');
  });

  it('does not let wallet A results overwrite wallet B after a context switch', async () => {
    const accountA = deferred<ReturnType<typeof creditAccount>>();
    const estimateA = deferred<ReturnType<typeof creditEstimate>>();
    mocks.getCreditAccount.mockImplementation((address: string) =>
      address === 'manifest1walleta'
        ? accountA.promise
        : Promise.resolve(creditAccount(9))
    );
    mocks.getCreditEstimate.mockImplementation((address: string) =>
      address === 'manifest1walleta'
        ? estimateA.promise
        : Promise.resolve(creditEstimate(2))
    );
    await render();

    let refreshA!: Promise<boolean | void>;
    act(() => {
      refreshA = latestRefresh()();
    });
    await vi.waitFor(() => expect(mocks.getCreditAccount).toHaveBeenCalledWith('manifest1walleta'));

    mocks.address = 'manifest1walletb';
    await render();
    await act(async () => {
      await latestRefresh()();
    });
    expect(container.textContent).toContain('9 PWR');
    expect(container.textContent).toContain('~2h remaining');

    await act(async () => {
      accountA.resolve(creditAccount(1));
      estimateA.resolve(creditEstimate(8));
      await refreshA;
    });

    expect(container.textContent).toContain('9 PWR');
    expect(container.textContent).toContain('~2h remaining');
    expect(container.textContent).not.toContain('1 PWR');
    expect(container.textContent).not.toContain('~8h remaining');
  });
});
