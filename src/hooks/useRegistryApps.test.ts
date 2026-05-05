import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, type FC } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { useRegistryApps } from './useRegistryApps';
import { addApp, removeApp, updateApp, type AppEntry } from '../registry/appRegistry';

const ADDR = 'manifest1abc';
const ADDR_OTHER = 'manifest1xyz';

function makeApp(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    name: 'my-app',
    leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
    size: 'small',
    providerUuid: '660e8400-e29b-41d4-a716-446655440000',
    providerUrl: 'https://provider.example.com',
    createdAt: Date.now(),
    status: 'running',
    ...overrides,
  };
}

const Wrapper: FC<{ address: string | undefined; onApps: (apps: AppEntry[]) => void }> = ({ address, onApps }) => {
  const apps = useRegistryApps(address);
  onApps(apps);
  return null;
};

describe('useRegistryApps', () => {
  let container: HTMLDivElement;
  let root: Root;
  let captured: AppEntry[] = [];

  beforeEach(() => {
    localStorage.clear();
    captured = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => { root.unmount(); });
    container.remove();
  });

  function render(address: string | undefined) {
    flushSync(() => {
      root.render(createElement(Wrapper, { address, onApps: (a) => { captured = a; } }));
    });
  }

  it('returns [] when address is undefined', () => {
    render(undefined);
    expect(captured).toEqual([]);
  });

  it('returns the existing apps for the wallet on mount', () => {
    addApp(ADDR, makeApp());
    render(ADDR);
    expect(captured).toHaveLength(1);
    expect(captured[0].name).toBe('my-app');
  });

  it('updates when a registry mutation fires for the subscribed address', () => {
    render(ADDR);
    expect(captured).toHaveLength(0);

    flushSync(() => { addApp(ADDR, makeApp()); });
    expect(captured).toHaveLength(1);

    flushSync(() => { updateApp(ADDR, captured[0].leaseUuid, { status: 'stopped' }); });
    expect(captured[0].status).toBe('stopped');

    flushSync(() => { removeApp(ADDR, captured[0].leaseUuid); });
    expect(captured).toHaveLength(0);
  });

  it('ignores mutations for other wallets', () => {
    render(ADDR);
    flushSync(() => { addApp(ADDR_OTHER, makeApp({ name: 'other' })); });
    expect(captured).toHaveLength(0);
  });

  it('returns the same reference across renders when nothing changed (snapshot stability)', () => {
    addApp(ADDR, makeApp());
    render(ADDR);
    const first = captured;
    render(ADDR);
    expect(captured).toBe(first);
  });
});
