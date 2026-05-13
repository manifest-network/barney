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

// Stub isApex so the new computeStatus signature is exercised deterministically
// and `tldts` stays out of the polling test's import graph. The polling test
// mocks `computeStatus` itself (above), so the return value here doesn't
// propagate to assertions — but the call must succeed.
vi.mock('../utils/customDomainValidation', () => ({
  isApex: vi.fn().mockReturnValue(false),
}));

vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

import { useDnsStatusPolling, deriveCandidateTargets } from './useDnsStatusPolling';
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

  it('flips polling off when a slice update marks the only domain terminal', () => {
    mounted = mountWith([makeApp()]);
    {
      const calls = vi.mocked(useVisibilityPolling).mock.calls;
      const opts = calls[calls.length - 1][2];
      expect(opts?.enabled).toBe(true);
    }

    // Mutate the slice the hook sees and force a re-render. Mirrors the real
    // effect of `setDnsStatuses` landing in the store between polls.
    dnsStatuses = new Map([
      ['lease-1::app.example.com', { kind: 'active' }],
    ]);
    flushSync(() => { mounted!.root.render(createElement(Wrapper, { apps: [makeApp()] })); });

    const calls = vi.mocked(useVisibilityPolling).mock.calls;
    const opts = calls[calls.length - 1][2];
    expect(opts?.enabled).toBe(false);
  });
});

describe('deriveCandidateTargets', () => {
  it('returns an empty list for no apps', () => {
    expect(deriveCandidateTargets([])).toEqual([]);
  });

  it('returns one entry per (running-app, customDomain) pair', () => {
    const apps = [
      makeApp({
        leaseUuid: 'lease-A',
        customDomains: [
          { serviceName: '', customDomain: 'a.example.com' },
          { serviceName: 'web', customDomain: 'b.example.com' },
        ],
      }),
      makeApp({ leaseUuid: 'lease-B', customDomains: [{ serviceName: '', customDomain: 'c.example.com' }] }),
    ];
    const targets = deriveCandidateTargets(apps);
    expect(targets).toHaveLength(3);
    expect(targets.map((t) => t.domain).sort()).toEqual([
      'a.example.com', 'b.example.com', 'c.example.com',
    ]);
  });

  it('excludes stopped apps', () => {
    const apps = [
      makeApp({ status: 'stopped' }),
      makeApp({ leaseUuid: 'lease-2', status: 'running' }),
    ];
    const targets = deriveCandidateTargets(apps);
    expect(targets).toHaveLength(1);
    expect(targets[0].app.leaseUuid).toBe('lease-2');
  });

  it('excludes apps with no customDomains', () => {
    const apps = [
      makeApp({ customDomains: undefined }),
      makeApp({ leaseUuid: 'lease-2', customDomains: [] }),
      makeApp({ leaseUuid: 'lease-3', customDomains: [{ serviceName: '', customDomain: 'x.example.com' }] }),
    ];
    const targets = deriveCandidateTargets(apps);
    expect(targets).toHaveLength(1);
    expect(targets[0].app.leaseUuid).toBe('lease-3');
  });
});
