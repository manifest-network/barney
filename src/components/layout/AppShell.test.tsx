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
let mockStatus = 'Disconnected';
let mockMessage: string | undefined;
const mockDisconnect = vi.fn().mockResolvedValue(undefined);

vi.mock('../../hooks/useManifestMCP', () => ({
  useManifestMCP: () => ({
    clientManager: null,
    address: mockAddress,
  }),
}));

vi.mock('@cosmos-kit/react', () => ({
  useChain: () => ({
    signArbitrary: vi.fn(),
    isWalletConnected: mockIsWalletConnected,
    isWalletConnecting: false,
    openView: vi.fn(),
    getOfflineSigner: vi.fn().mockReturnValue({ getAccounts: vi.fn() }),
    status: mockStatus,
    message: mockMessage,
    disconnect: mockDisconnect,
  }),
}));

const mockToast = { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() };
vi.mock('../../hooks/useToast', () => ({
  useToast: () => mockToast,
}));

vi.mock('../../hooks/useAccountSetup', () => ({
  useAccountSetup: vi.fn().mockReturnValue({ isInitialSetup: false, phase: 'checking' }),
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

// --- Helpers ---

let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => { root.render(createElement(AppShell)); });
}

/** Render and wait for React.lazy Suspense to resolve.
 * React.lazy wraps import() in a thenable. We yield to the event loop via
 * setTimeout to let vitest's module loader settle, then re-mount so Suspense
 * renders the resolved component.
 * NOTE: vi.useRealTimers() is required because other test files may leave
 * fake timers active in parallel mode. */
async function renderAsync() {
  vi.useRealTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  const el = createElement(AppShell);
  flushSync(() => { root.render(el); });

  // Yield to event loop — lets the dynamic import() promise settle
  await new Promise<void>((r) => { setTimeout(r, 50); });

  // Re-mount — React.lazy now has the resolved module cached
  flushSync(() => { root.render(null); });
  flushSync(() => { root.render(el); });
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mockIsWalletConnected = false;
  mockAddress = undefined;
  mockStatus = 'Disconnected';
  mockMessage = undefined;
});

afterEach(() => {
  flushSync(() => { root?.unmount(); });
  container?.remove();
});

describe('AppShell', () => {
  it('renders LandingPage when not connected', async () => {
    await renderAsync();
    expect(container.querySelector('[data-testid="landing"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="main-layout"]')).toBeNull();
  });

  it('renders MainLayout when connected', async () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1test';
    await renderAsync();
    expect(container.querySelector('[data-testid="main-layout"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="landing"]')).toBeNull();
  });

  it('syncs wallet state to AI context', () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1test';
    render();
    expect(mockSetAddress).toHaveBeenCalledWith('manifest1test');
  });

  it('shows warning toast when popup is blocked', () => {
    render();
    mockStatus = 'Error';
    mockMessage = 'Popup was blocked by the browser';
    flushSync(() => { root.render(createElement(AppShell)); });
    expect(mockToast.warning).toHaveBeenCalledWith(
      'Pop-up blocked by your browser. Please allow pop-ups for this site and try again.',
      8000
    );
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('shows info toast when user closes popup', () => {
    render();
    mockStatus = 'Rejected';
    mockMessage = 'popup has been closed by the user';
    flushSync(() => { root.render(createElement(AppShell)); });
    expect(mockToast.info).toHaveBeenCalledWith('Login cancelled.');
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('shows error toast for generic connection errors', () => {
    render();
    mockStatus = 'Error';
    mockMessage = 'Network error';
    flushSync(() => { root.render(createElement(AppShell)); });
    expect(mockToast.error).toHaveBeenCalledWith('Connection failed: Network error');
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('does not show any toast for normal Disconnected status', () => {
    mockStatus = 'Disconnected';
    render();
    expect(mockToast.warning).not.toHaveBeenCalled();
    expect(mockToast.info).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(mockDisconnect).not.toHaveBeenCalled();
  });
});
