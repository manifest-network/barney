import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mocks = vi.hoisted(() => ({
  address: 'manifest1walleta' as string | undefined,
  disconnect: vi.fn(),
  sendMessage: vi.fn(),
  attachPayload: vi.fn(),
  getApps: vi.fn(),
  subscribeToRegistry: vi.fn(),
  getCreditAccount: vi.fn(),
  getCreditEstimate: vi.fn(),
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

function creditEstimate(hours: number) {
  return {
    totalRatePerSecond: [{ denom: 'upwr', amount: '1000' }],
    estimatedDurationSeconds: BigInt(hours * 3_600),
  };
}

describe('AppsSidebar with the real visibility poller', () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.address = 'manifest1walleta';
    mocks.getApps.mockReturnValue([]);
    mocks.subscribeToRegistry.mockReturnValue(() => undefined);
    mocks.getCreditAccount.mockImplementation(async (address: string) =>
      creditAccount(address === 'manifest1walleta' ? 5 : 9)
    );
    mocks.getCreditEstimate.mockImplementation(async (address: string) =>
      creditEstimate(address === 'manifest1walleta' ? 2 : 4)
    );
    mocks.disconnect.mockResolvedValue(undefined);
    mocks.attachPayload.mockResolvedValue({});
    Object.defineProperty(document, 'hidden', {
      value: false,
      writable: true,
      configurable: true,
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mounted = true;
  });

  afterEach(() => {
    if (mounted) act(() => root.unmount());
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(): Promise<void> {
    await act(async () => {
      root.render(createElement(AppsSidebar));
    });
  }

  it('populates the initial wallet and restarts immediately for a wallet switch', async () => {
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain('5 PWR'));
    expect(container.textContent).toContain('~2h remaining');

    mocks.address = 'manifest1walletb';
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain('9 PWR'));
    expect(container.textContent).toContain('~4h remaining');
    expect(mocks.getCreditAccount).toHaveBeenCalledWith('manifest1walletb');
  });

  it('drops read failures that settle after unmount', async () => {
    const account = deferred<ReturnType<typeof creditAccount>>();
    const estimate = deferred<ReturnType<typeof creditEstimate>>();
    mocks.getCreditAccount.mockReturnValue(account.promise);
    mocks.getCreditEstimate.mockReturnValue(estimate.promise);

    await render();
    await vi.waitFor(() => expect(mocks.getCreditAccount).toHaveBeenCalledOnce());

    act(() => root.unmount());
    mounted = false;
    await act(async () => {
      account.reject(new Error('late account failure'));
      estimate.reject(new Error('late estimate failure'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.logError).not.toHaveBeenCalled();
  });
});
