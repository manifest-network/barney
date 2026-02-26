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

vi.mock('@cosmos-kit/react', () => ({
  useChain: () => ({
    signArbitrary: vi.fn(),
    isWalletConnected: mockIsWalletConnected,
    isWalletConnecting: false,
    openView: vi.fn(),
    getOfflineSigner: vi.fn().mockReturnValue({ getAccounts: vi.fn() }),
  }),
}));

const mockToast = { success: vi.fn(), info: vi.fn(), error: vi.fn() };
vi.mock('../../hooks/useToast', () => ({
  useToast: () => mockToast,
}));

vi.mock('../../hooks/useAutoRefill', () => ({
  useAutoRefill: vi.fn().mockReturnValue({ isInitialSetup: false, phase: 'checking' }),
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

beforeEach(() => {
  vi.clearAllMocks();
  mockIsWalletConnected = false;
  mockAddress = undefined;
});

afterEach(() => {
  flushSync(() => { root?.unmount(); });
  container?.remove();
});

describe('AppShell', () => {
  it('renders LandingPage when not connected', () => {
    render();
    expect(container.querySelector('[data-testid="landing"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="main-layout"]')).toBeNull();
  });

  it('renders MainLayout when connected', () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1test';
    render();
    expect(container.querySelector('[data-testid="main-layout"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="landing"]')).toBeNull();
  });

  it('syncs wallet state to AI context', () => {
    mockIsWalletConnected = true;
    mockAddress = 'manifest1test';
    render();
    expect(mockSetAddress).toHaveBeenCalledWith('manifest1test');
  });
});
