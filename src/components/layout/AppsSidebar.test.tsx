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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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

function registryApp(name: string, leaseUuid: string) {
  return {
    name,
    leaseUuid,
    size: 'micro',
    providerUuid: `provider-${name}`,
    providerUrl: `https://${name}.provider.example`,
    createdAt: 1,
    status: 'running' as const,
  };
}

function isWalletContext(value: unknown, address: string): boolean {
  return typeof value === 'object'
    && value !== null
    && 'address' in value
    && value.address === address;
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

  it('hides wallet A app rows until wallet B registry state refreshes', async () => {
    mocks.getApps.mockImplementation((address: string) => [
      address === 'manifest1walleta'
        ? registryApp('wallet-a-app', 'lease-a')
        : registryApp('wallet-b-app', 'lease-b'),
    ]);
    await render();
    const refreshA = latestRefresh();
    const subscriptionA = mocks.subscribeToRegistry.mock.calls.at(-1)?.[0] as
      ((mutatedAddress: string) => void) | undefined;
    expect(subscriptionA).toBeDefined();
    await act(async () => {
      await refreshA();
    });
    expect(container.textContent).toContain('wallet-a-app');

    mocks.address = 'manifest1walletb';
    await render();

    expect(container.textContent).not.toContain('wallet-a-app');
    expect(container.textContent).not.toContain('wallet-b-app');
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    const refreshB = latestRefresh();
    await act(async () => {
      await refreshB();
    });
    expect(container.textContent).toContain('wallet-b-app');
    expect(container.textContent).not.toContain('wallet-a-app');

    // Even if an old poll callback or registry subscriber is delivered after
    // B has populated, neither A writer may replace B's visible snapshot.
    await act(async () => {
      await refreshA();
    });
    expect(container.textContent).toContain('wallet-b-app');
    act(() => {
      subscriptionA?.('manifest1walleta');
    });
    expect(container.textContent).toContain('wallet-b-app');
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
    const refreshingButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Refreshing…',
    );
    expect(refreshingButton).toBeDefined();
    expect(refreshingButton?.disabled).toBe(true);
    await act(async () => {
      refreshingButton?.click();
    });
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

  it('blocks Retry before busy state commits when an automatic pass already started', async () => {
    mocks.getCreditAccount.mockRejectedValue(new Error('account unavailable'));
    mocks.getCreditEstimate.mockRejectedValue(new Error('estimate unavailable'));
    await render();
    await act(async () => {
      await expect(latestRefresh()()).resolves.toBe(false);
    });

    const account = deferred<ReturnType<typeof creditAccount>>();
    const estimate = deferred<ReturnType<typeof creditEstimate>>();
    mocks.getCreditAccount.mockReturnValue(account.promise);
    mocks.getCreditEstimate.mockReturnValue(estimate.promise);
    const retryButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry',
    );
    expect(retryButton).toBeDefined();

    let automaticRefresh!: Promise<boolean | void>;
    act(() => {
      automaticRefresh = latestRefresh()();
      // This click occurs before React can commit the disabled state. The
      // imperative in-flight guard must still prevent a poller restart.
      retryButton?.click();
    });

    expect(mocks.useVisibilityPolling).toHaveBeenLastCalledWith(
      expect.any(Function),
      15_000,
      expect.objectContaining({ restartKey: 'manifest1walleta' }),
    );
    const refreshingButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Refreshing…',
    );
    expect(refreshingButton?.disabled).toBe(true);

    await act(async () => {
      account.resolve(creditAccount(42));
      estimate.resolve(creditEstimate(6));
      await automaticRefresh;
    });
    expect(container.textContent).toContain('42 PWR');
    expect(container.textContent).toContain('~6h remaining');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('releases an unclaimed Retry reservation when its wallet lifecycle ends', async () => {
    mocks.getCreditAccount.mockRejectedValue(new Error('account unavailable'));
    mocks.getCreditEstimate.mockRejectedValue(new Error('estimate unavailable'));
    await render();

    // Capture the exact activity collections, then assert their retained size.
    // Watching delete calls alone could be satisfied by an unrelated stale
    // refresh that happens to use the same wallet-context key.
    const mapSetSpy = vi.spyOn(Map.prototype, 'set');
    const setDeleteSpy = vi.spyOn(Set.prototype, 'delete');
    let activityCounts!: Map<unknown, unknown>;
    let pendingRetries!: Set<unknown>;
    try {
      await act(async () => {
        await expect(latestRefresh()()).resolves.toBe(false);
      });
      const countReceiverIndex = mapSetSpy.mock.calls.findIndex(([context, count]) =>
        isWalletContext(context, 'manifest1walleta') && count === 1
      );
      const pendingReceiverIndex = setDeleteSpy.mock.calls.findIndex(([context]) =>
        isWalletContext(context, 'manifest1walleta')
      );
      expect(countReceiverIndex).toBeGreaterThanOrEqual(0);
      expect(pendingReceiverIndex).toBeGreaterThanOrEqual(0);
      activityCounts = mapSetSpy.mock.contexts[countReceiverIndex] as Map<unknown, unknown>;
      pendingRetries = setDeleteSpy.mock.contexts[pendingReceiverIndex] as Set<unknown>;
      expect(activityCounts).toBeInstanceOf(Map);
      expect(pendingRetries).toBeInstanceOf(Set);
    } finally {
      mapSetSpy.mockRestore();
      setDeleteSpy.mockRestore();
    }
    expect(activityCounts.size).toBe(0);
    expect(pendingRetries.size).toBe(0);

    const retryButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry',
    );
    await act(async () => {
      retryButton?.click();
    });
    expect(container.textContent).toContain('Refreshing…');
    expect(activityCounts.size).toBe(1);
    expect(pendingRetries.size).toBe(1);

    mocks.address = 'manifest1walletb';
    await render();
    expect(activityCounts.size).toBe(0);
    expect(pendingRetries.size).toBe(0);

    // Ownership must advance with the replacement wallet; otherwise every
    // later switch would keep trying to release A while leaking B, C, ….
    await act(async () => {
      await expect(latestRefresh()()).resolves.toBe(false);
    });
    const walletBRetry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry',
    );
    await act(async () => {
      walletBRetry?.click();
    });
    expect(container.textContent).toContain('Refreshing…');
    expect(activityCounts.size).toBe(1);
    expect(pendingRetries.size).toBe(1);

    mocks.address = 'manifest1walletc';
    await render();
    expect(activityCounts.size).toBe(0);
    expect(pendingRetries.size).toBe(0);
  });

  it('releases refresh activity when setup throws before the billing reads', async () => {
    mocks.getCreditAccount.mockRejectedValue(new Error('account unavailable'));
    mocks.getCreditEstimate.mockRejectedValue(new Error('estimate unavailable'));
    await render();
    await act(async () => {
      await expect(latestRefresh()()).resolves.toBe(false);
    });

    mocks.getApps.mockImplementationOnce(() => {
      throw new Error('registry read failed');
    });
    await act(async () => {
      await expect(latestRefresh()()).rejects.toThrow('registry read failed');
    });

    const retryButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry',
    );
    expect(retryButton?.disabled).toBe(false);
    expect(retryButton?.getAttribute('aria-busy')).toBe('false');
  });

  it('keeps Retry disabled until every same-wallet refresh pass settles', async () => {
    mocks.getCreditAccount.mockRejectedValue(new Error('account unavailable'));
    mocks.getCreditEstimate.mockRejectedValue(new Error('estimate unavailable'));
    await render();
    await act(async () => {
      await expect(latestRefresh()()).resolves.toBe(false);
    });

    const accountOne = deferred<ReturnType<typeof creditAccount>>();
    const estimateOne = deferred<ReturnType<typeof creditEstimate>>();
    const accountTwo = deferred<ReturnType<typeof creditAccount>>();
    const estimateTwo = deferred<ReturnType<typeof creditEstimate>>();
    mocks.getCreditAccount
      .mockReturnValueOnce(accountOne.promise)
      .mockReturnValueOnce(accountTwo.promise);
    mocks.getCreditEstimate
      .mockReturnValueOnce(estimateOne.promise)
      .mockReturnValueOnce(estimateTwo.promise);

    const refresh = latestRefresh();
    let firstPass!: Promise<boolean | void>;
    let secondPass!: Promise<boolean | void>;
    act(() => {
      firstPass = refresh();
      secondPass = refresh();
    });
    expect(Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Refreshing…',
    )?.disabled).toBe(true);

    await act(async () => {
      accountOne.reject(new Error('first account failure'));
      estimateOne.reject(new Error('first estimate failure'));
      await firstPass;
    });
    expect(Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Refreshing…',
    )?.disabled).toBe(true);

    await act(async () => {
      accountTwo.reject(new Error('second account failure'));
      estimateTwo.reject(new Error('second estimate failure'));
      await secondPass;
    });
    expect(Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry',
    )?.disabled).toBe(false);
  });

  it.each([
    {
      failedRead: 'balance',
      expectedCopy: 'Couldn’t load credit balance.',
    },
    {
      failedRead: 'estimate',
      expectedCopy: 'Couldn’t load credit estimate.',
    },
  ] as const)('identifies a first-load $failedRead failure', async ({
    failedRead,
    expectedCopy,
  }) => {
    if (failedRead === 'balance') {
      mocks.getCreditAccount.mockRejectedValue(new Error('account unavailable'));
      mocks.getCreditEstimate.mockResolvedValue(creditEstimate(4));
    } else {
      mocks.getCreditAccount.mockResolvedValue(creditAccount(7));
      mocks.getCreditEstimate.mockRejectedValue(new Error('estimate unavailable'));
    }
    await render();
    await act(async () => {
      await expect(latestRefresh()()).resolves.toBe(false);
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(expectedCopy);
    if (failedRead === 'balance') {
      expect(container.querySelector('.apps-sidebar__credits-amount')?.textContent).toBe('--');
      expect(container.textContent).toContain('~4h remaining');
    } else {
      expect(container.textContent).toContain('7 PWR');
      expect(container.textContent).not.toContain('remaining');
    }
  });

  it.each([
    {
      failedRead: 'both',
      expectedCopy: 'Couldn’t refresh credit details.',
    },
    {
      failedRead: 'balance',
      expectedCopy: 'Couldn’t refresh credit balance.',
    },
    {
      failedRead: 'estimate',
      expectedCopy: 'Couldn’t refresh credit estimate.',
    },
  ] as const)('identifies a failed $failedRead refresh while retaining good data', async ({
    failedRead,
    expectedCopy,
  }) => {
    mocks.getCreditAccount.mockResolvedValue(creditAccount(5));
    mocks.getCreditEstimate.mockResolvedValue(creditEstimate(2));
    await render();
    await act(async () => {
      await latestRefresh()();
    });

    if (failedRead === 'both' || failedRead === 'balance') {
      mocks.getCreditAccount.mockRejectedValue(new Error('account unavailable'));
    } else {
      mocks.getCreditAccount.mockResolvedValue(creditAccount(7));
    }
    if (failedRead === 'both' || failedRead === 'estimate') {
      mocks.getCreditEstimate.mockRejectedValue(new Error('estimate unavailable'));
    } else {
      mocks.getCreditEstimate.mockResolvedValue(creditEstimate(4));
    }

    await act(async () => {
      await expect(latestRefresh()()).resolves.toBe(false);
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(expectedCopy);
    expect(container.textContent).toContain(
      failedRead === 'estimate' ? '7 PWR' : '5 PWR',
    );
    expect(container.textContent).toContain(
      failedRead === 'balance' ? '~4h remaining' : '~2h remaining',
    );
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
