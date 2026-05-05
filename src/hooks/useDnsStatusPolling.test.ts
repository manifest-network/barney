import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, type FC } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('./useVisibilityPolling', () => ({
  useVisibilityPolling: vi.fn(),
}));

let dnsStatuses: Map<string, { kind: string; expectedCnameTarget?: string }> = new Map();
const setDnsStatuses = vi.fn();

vi.mock('./useAI', () => ({
  useAI: () => ({ dnsStatuses, setDnsStatuses }),
}));

vi.mock('../utils/customDomainStatus', () => ({
  resolveDnsViaDoh: vi.fn(),
  probeHttps: vi.fn(),
  computeStatus: vi.fn(),
}));

vi.mock('../utils/connection', () => ({
  resolveExpectedCnameTarget: vi.fn().mockReturnValue('auto.barney0.manifest0.net'),
}));

vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

import { useDnsStatusPolling } from './useDnsStatusPolling';
import { useVisibilityPolling } from './useVisibilityPolling';
import { resolveDnsViaDoh, probeHttps, computeStatus } from '../utils/customDomainStatus';
import type { AppEntry } from '../registry/appRegistry';

function makeApp(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    name: 'my-app',
    leaseUuid: 'lease-1',
    size: 'small',
    providerUuid: 'p-1',
    providerUrl: 'https://fred.example.com',
    createdAt: 0,
    status: 'running',
    customDomains: [{ serviceName: '', customDomain: 'app.example.com' }],
    ...overrides,
  };
}

const Wrapper: FC<{ apps: AppEntry[] }> = ({ apps }) => {
  useDnsStatusPolling(apps);
  return null;
};

function mountWith(apps: AppEntry[]): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => { root.render(createElement(Wrapper, { apps })); });
  return { container, root };
}

describe('useDnsStatusPolling', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    dnsStatuses = new Map();
  });

  afterEach(() => {
    if (mounted) {
      flushSync(() => { mounted!.root.unmount(); });
      mounted.container.remove();
      mounted = null;
    }
  });

  it('disables visibility polling when no apps have domains', () => {
    mounted = mountWith([makeApp({ customDomains: undefined })]);
    const calls = vi.mocked(useVisibilityPolling).mock.calls;
    const lastOpts = calls[calls.length - 1][2];
    expect(lastOpts?.enabled).toBe(false);
  });

  it('enables polling when at least one app has a non-terminal domain', () => {
    mounted = mountWith([makeApp()]);
    const calls = vi.mocked(useVisibilityPolling).mock.calls;
    const lastOpts = calls[calls.length - 1][2];
    expect(lastOpts?.enabled).toBe(true);
  });

  it('skips apps whose domains are all in terminal states', () => {
    dnsStatuses = new Map([
      ['lease-1::app.example.com', { kind: 'active' }],
    ]);
    mounted = mountWith([makeApp()]);
    const calls = vi.mocked(useVisibilityPolling).mock.calls;
    const lastOpts = calls[calls.length - 1][2];
    expect(lastOpts?.enabled).toBe(false);
  });

  it('skips stopped apps', () => {
    mounted = mountWith([makeApp({ status: 'stopped' })]);
    const calls = vi.mocked(useVisibilityPolling).mock.calls;
    const lastOpts = calls[calls.length - 1][2];
    expect(lastOpts?.enabled).toBe(false);
  });

  it('runs probes when polling fires and writes to the store', async () => {
    let pollFn: () => Promise<unknown> = async () => undefined;
    vi.mocked(useVisibilityPolling).mockImplementation((cb) => { pollFn = cb; });
    vi.mocked(resolveDnsViaDoh).mockResolvedValue({ result: 'ok' } as any);
    vi.mocked(probeHttps).mockResolvedValue({ result: 'ok' } as any);
    vi.mocked(computeStatus).mockReturnValue({ kind: 'active' } as any);

    mounted = mountWith([makeApp()]);
    await pollFn();

    expect(setDnsStatuses).toHaveBeenCalled();
    const next = setDnsStatuses.mock.calls[0][0] as Map<string, { kind: string }>;
    expect(next.get('lease-1::app.example.com')?.kind).toBe('active');
  });

  it('propagates the report detail (e.g. wrong-target diff) into the store entry', async () => {
    let pollFn: () => Promise<unknown> = async () => undefined;
    vi.mocked(useVisibilityPolling).mockImplementation((cb) => { pollFn = cb; });
    vi.mocked(resolveDnsViaDoh).mockResolvedValue({ result: 'ok', cname: 'wrong.host' } as any);
    vi.mocked(probeHttps).mockResolvedValue({ result: 'ok' } as any);
    vi.mocked(computeStatus).mockReturnValue({
      kind: 'pending_dns',
      detail: 'Pointed at wrong.host — expected auto.barney0.manifest0.net',
    } as any);

    mounted = mountWith([makeApp()]);
    await pollFn();

    const next = setDnsStatuses.mock.calls[0][0] as Map<string, { kind: string; detail?: string }>;
    const entry = next.get('lease-1::app.example.com');
    expect(entry?.kind).toBe('pending_dns');
    expect(entry?.detail).toBe('Pointed at wrong.host — expected auto.barney0.manifest0.net');
  });
});
