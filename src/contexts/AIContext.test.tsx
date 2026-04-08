/**
 * Regression test for the StrictMode + singleton orphaning bug.
 *
 * Before the Context refactor, AIProvider held the store via a module-level
 * `_store` singleton that was nulled out by `destroy()` in useEffect cleanup.
 * Under React StrictMode's simulated unmount/remount, the cleanup ran AFTER
 * the initial health-check fetch had been dispatched. When that fetch resolved
 * and called `setState({ isConnected: true })`, the next consumer re-render
 * called `getAIStore()` → saw `_store === null` → created a brand new empty
 * store → "not connected" stuck on screen indefinitely.
 *
 * The fix is the official zustand vanilla-store-in-context pattern:
 *   - Provider creates the store with `useState(() => createAIStore())`
 *   - Consumers read it via `useContext` + `useStore`
 *
 * With that, there is no module-level state to orphan.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, createElement, useContext, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { StoreApi } from 'zustand';

vi.mock('../api/morpheus', () => ({
  checkApiHealth: vi.fn().mockResolvedValue(true),
}));

// Mock persistence so the test doesn't depend on real localStorage state and
// can't have its assertions clouded by validation errors swallowed inside
// loadSettings/loadHistory.
vi.mock('../stores/aiActions/persistence', () => ({
  loadSettings: vi.fn().mockReturnValue({ saveHistory: true }),
  loadHistory: vi.fn().mockReturnValue([]),
  clearHistoryStorage: vi.fn(),
  saveSettings: vi.fn(),
  saveHistory: vi.fn(),
  setupPersistenceSubscriptions: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

import { AIProvider } from './AIContext';
import { AIStoreContext, useAIStore } from './aiStoreContext';
import { checkApiHealth } from '../api/morpheus';
import { logError } from '../utils/errors';
import type { AIStore } from '../stores/aiStore';

const rendered: { root: Root; container: HTMLElement }[] = [];

beforeEach(() => {
  vi.mocked(checkApiHealth).mockResolvedValue(true);
  vi.mocked(logError).mockClear();
});

afterEach(() => {
  for (const { root, container } of rendered) {
    try { flushSync(() => root.unmount()); } catch { /* already unmounted */ }
    container.remove();
  }
  rendered.length = 0;
});

function StatusProbe() {
  const isConnected = useAIStore((s) => s.isConnected);
  return createElement('div', { 'data-testid': 'status' }, isConnected ? 'connected' : 'not-connected');
}

function mount(node: React.ReactNode): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  rendered.push({ root, container });
  flushSync(() => { root.render(node); });
  return { container, root };
}

// Yield long enough for the mocked checkApiHealth promise + state propagation
// to flush. checkApiHealth is a resolved mock so a single microtask suffices,
// but we double-tick to be safe across React/Zustand internal scheduling.
async function flushAsync() {
  await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 50));
}

describe('AIProvider — StrictMode regression', () => {
  it('reaches connected state under StrictMode after the initial health-check tick', async () => {
    const { container } = mount(
      createElement(StrictMode, null,
        createElement(AIProvider, null,
          createElement(StatusProbe)
        )
      )
    );

    await flushAsync();

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('connected');
    expect(logError).not.toHaveBeenCalled();
  });

  it('reaches connected state without StrictMode (control)', async () => {
    const { container } = mount(
      createElement(AIProvider, null,
        createElement(StatusProbe)
      )
    );

    await flushAsync();

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('connected');
    expect(logError).not.toHaveBeenCalled();
  });

  it('store identity is stable across StrictMode double-mount', async () => {
    const observed: StoreApi<AIStore>[] = [];

    function StoreIdentityProbe() {
      const store = useContext(AIStoreContext);
      // Capture the store reference on each commit. StrictMode simulates an
      // extra mount → cleanup → remount, so we expect ≥2 captures all
      // pointing at the same StoreApi instance.
      useEffect(() => {
        if (store) observed.push(store);
      });
      return null;
    }

    mount(
      createElement(StrictMode, null,
        createElement(AIProvider, null,
          createElement(StoreIdentityProbe)
        )
      )
    );

    await flushAsync();

    expect(observed.length).toBeGreaterThanOrEqual(2);
    const first = observed[0];
    for (const s of observed) {
      expect(s).toBe(first);
    }
  });
});

describe('AIProvider — checkConnection failure path', () => {
  it('renders not-connected and does not throw when checkApiHealth rejects', async () => {
    vi.mocked(checkApiHealth).mockRejectedValueOnce(new Error('network down'));

    const { container } = mount(
      createElement(AIProvider, null,
        createElement(StatusProbe)
      )
    );

    await flushAsync();

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('not-connected');
    expect(logError).toHaveBeenCalledWith('aiStore.checkConnection', expect.any(Error));
  });
});

describe('AIProvider — unmount mid-fetch', () => {
  it('does not throw or warn when the Provider unmounts while a health check is in flight', async () => {
    // Make checkApiHealth take longer than the unmount window.
    let resolveHealth: (v: boolean) => void = () => {};
    vi.mocked(checkApiHealth).mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { resolveHealth = resolve; })
    );

    const { root } = mount(
      createElement(AIProvider, null,
        createElement(StatusProbe)
      )
    );

    // Unmount immediately, while checkApiHealth is still pending.
    flushSync(() => root.unmount());

    // Now resolve the in-flight fetch — it should land on the (still-alive
    // in JS memory) store without throwing or producing setState-after-unmount
    // warnings, because there is no module-level singleton to be null.
    resolveHealth(true);
    await flushAsync();

    expect(logError).not.toHaveBeenCalled();
  });
});
