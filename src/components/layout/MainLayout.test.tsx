import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const {
  apps,
  useRegistryReconciliation,
  useDnsStatusPolling,
} = vi.hoisted(() => ({
  apps: [{ leaseUuid: 'lease-1' }],
  useRegistryReconciliation: vi.fn(),
  useDnsStatusPolling: vi.fn(),
}));

vi.mock('@cosmos-kit/react', () => ({
  useChain: () => ({ address: 'manifest1layout' }),
}));
vi.mock('../../hooks/useRegistryApps', () => ({
  useRegistryApps: () => apps,
}));
vi.mock('../../hooks/useRegistryReconciliation', () => ({
  useRegistryReconciliation,
}));
vi.mock('../../hooks/useDnsStatusPolling', () => ({
  useDnsStatusPolling,
}));
vi.mock('./AppsSidebar', () => ({ AppsSidebar: () => null }));
vi.mock('../ai/ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('../ai/AIErrorBoundary', () => ({
  AIErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../ui/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../ui/Modal', () => ({ Modal: () => null }));

import { MainLayout } from './MainLayout';

describe('MainLayout registry drivers', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.clearAllMocks();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('mounts registry reconciliation alongside DNS polling outside sidebar content', () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(MainLayout)));

    expect(useRegistryReconciliation).toHaveBeenCalledWith('manifest1layout');
    expect(useDnsStatusPolling).toHaveBeenCalledWith(apps);
  });
});
