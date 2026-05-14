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
import { resolveExpectedCnameTarget } from '../utils/connection';
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

  // Regression: prior to the customDomainStatus gate at known-target, an
  // undefined `expectedCnameTarget` on tick 1 produced `active` via the
  // no-cors HTTPS probe, and the polling driver's terminal filter (line 108)
  // locked it in. Tick 2 (after the target appeared in `app.connection` —
  // e.g. a successful Fred round-trip after a fallback path) was skipped
  // because `isTerminal` filtered the entry out of the polling set.
  // After the fix, tick 1 stays `pending_dns` (non-terminal), so tick 2 is
  // still in the polling set and can transition to `active`. See PR #93
  // Copilot 3237018335.
  it('transitions out of pending_dns once expectedCnameTarget becomes available', async () => {
    let pollFn: () => Promise<unknown> = async () => undefined;
    vi.mocked(useVisibilityPolling).mockImplementation((cb) => { pollFn = cb; });
    vi.mocked(resolveDnsViaDoh).mockResolvedValue({ result: 'ok' } as any);
    vi.mocked(probeHttps).mockResolvedValue({ result: 'ok' } as any);

    // Tick 1: target undefined → reducer returns pending_dns (mocked).
    vi.mocked(resolveExpectedCnameTarget).mockReturnValueOnce(undefined);
    vi.mocked(computeStatus).mockReturnValueOnce({
      kind: 'pending_dns',
      detail: 'Waiting for provider info…',
    } as any);

    mounted = mountWith([makeApp()]);
    await pollFn();
    const firstCall = setDnsStatuses.mock.calls[0][0] as Map<string, { kind: string }>;
    expect(firstCall.get('lease-1::app.example.com')?.kind).toBe('pending_dns');

    // Simulate the slice update landing — the next tick's terminal filter
    // (`isTerminal` at line 108) reads from this map. `pending_dns` is
    // non-terminal, so the entry STAYS in the polling set.
    dnsStatuses = firstCall;

    // Tick 2: target now populated → reducer returns active.
    vi.mocked(resolveExpectedCnameTarget).mockReturnValueOnce('auto.barney0.manifest0.net');
    vi.mocked(computeStatus).mockReturnValueOnce({ kind: 'active' } as any);

    flushSync(() => { mounted!.root.render(createElement(Wrapper, { apps: [makeApp()] })); });
    await pollFn();
    const lastCall = setDnsStatuses.mock.calls[setDnsStatuses.mock.calls.length - 1][0] as Map<string, { kind: string }>;
    expect(lastCall.get('lease-1::app.example.com')?.kind).toBe('active');
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

  // Contract: useDnsStatusPolling treats a reference-stable `apps` array as a
  // no-op for the abort-on-change cleanup effect. The hook memoizes
  // `allTargets` on `[apps]` and the cleanup effect on line ~106 keys off
  // `[allTargets]`. If a future change removes the `useMemo` (line ~75), every
  // render produces a fresh `allTargets` array, fires the cleanup, and aborts
  // every in-flight DoH/HTTPS probe on every parent re-render. This test goes
  // red in that scenario. Forward-looking contract guard — not a behavior
  // check on current code (the memo is in place; this passes today).
  it('contract: does not abort in-flight probes when re-rendered with the same apps reference (memo guard)', async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    let pollFn: () => Promise<unknown> = async () => undefined;
    vi.mocked(useVisibilityPolling).mockImplementation((cb) => { pollFn = cb; });
    vi.mocked(resolveDnsViaDoh).mockResolvedValue({ result: 'ok' } as any);
    vi.mocked(probeHttps).mockResolvedValue({ result: 'ok' } as any);
    vi.mocked(computeStatus).mockReturnValue({ kind: 'pending_dns' } as any);

    const apps = [makeApp()]; // stable reference held across renders
    mounted = mountWith(apps);
    await pollFn();          // creates an AbortController for the first poll
    abortSpy.mockClear();    // ignore any aborts from the poll itself

    // Re-render with the EXACT same `apps` array reference. With the
    // memo in place this is a no-op for `allTargets`; the cleanup effect
    // doesn't fire; no abort.
    flushSync(() => { mounted!.root.render(createElement(Wrapper, { apps })); });

    expect(abortSpy).not.toHaveBeenCalled();
    abortSpy.mockRestore();
  });

  // Regression: prior to this fix, the cleanup effect at useDnsStatusPolling.ts:99
  // had an empty dep array — it only fired on hook unmount. Wallet switches
  // (which change `allTargets` but don't unmount) left in-flight DoH probes
  // running. They'd resolve naturally and write the prior wallet's lease/domain
  // entries into the new wallet's dnsStatuses. See PR #93 Copilot 3237018271.
  it('aborts in-flight probes when the candidate target list changes', async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    let pollFn: () => Promise<unknown> = async () => undefined;
    vi.mocked(useVisibilityPolling).mockImplementation((cb) => { pollFn = cb; });
    vi.mocked(resolveDnsViaDoh).mockResolvedValue({ result: 'ok' } as any);
    vi.mocked(probeHttps).mockResolvedValue({ result: 'ok' } as any);
    vi.mocked(computeStatus).mockReturnValue({ kind: 'pending_dns' } as any);

    mounted = mountWith([makeApp()]);
    await pollFn();          // creates an AbortController for the first poll
    abortSpy.mockClear();    // ignore any aborts from the poll itself

    // Switch to a different candidate set — re-render with empty apps. This
    // must trigger the cleanup-effect's abort on the prior in-flight controller.
    flushSync(() => { mounted!.root.render(createElement(Wrapper, { apps: [] })); });

    expect(abortSpy).toHaveBeenCalled();
    abortSpy.mockRestore();
  });

  it('does not leak stale probe results into the next wallet\'s dnsStatuses on wallet switch', async () => {
    let pollFn: () => Promise<unknown> = async () => undefined;
    vi.mocked(useVisibilityPolling).mockImplementation((cb) => { pollFn = cb; });

    // Controlled promise so we can re-render mid-await before resolving.
    let resolveProbe: (v: { result: string }) => void = () => {};
    const pending = new Promise<{ result: string }>((r) => { resolveProbe = r; });
    vi.mocked(resolveDnsViaDoh).mockReturnValueOnce(pending as any);
    vi.mocked(probeHttps).mockReturnValueOnce(pending as any);
    vi.mocked(computeStatus).mockReturnValue({ kind: 'pending_dns' } as any);

    mounted = mountWith([makeApp({
      customDomains: [{ serviceName: '', customDomain: 'wallet-a.example.com' }],
    })]);
    const pollPromise = pollFn();

    // Wallet switch: re-render with no apps. Cleanup-effect aborts the
    // in-flight probe; signal.aborted check at the top of the merge bails out.
    flushSync(() => { mounted!.root.render(createElement(Wrapper, { apps: [] })); });

    // Resolve the pending probe so the awaited Promise.all settles.
    resolveProbe({ result: 'ok' });
    await pollPromise;

    // No write should land for wallet-a's domain after the candidate set went empty.
    const writtenKeys = setDnsStatuses.mock.calls.flatMap(
      (c) => Array.from((c[0] as Map<string, unknown>).keys()),
    );
    expect(writtenKeys).not.toContain('lease-1::wallet-a.example.com');
  });

  // Documents the no-orphan invariant for the merge loop's defensive filter.
  // With the abort-on-candidate-change in place, the abort fires before the
  // merge runs in scenarios constructible from the test surface, so this test
  // would also pass with abort-only. The defensive filter exists to close a
  // narrow microtask race between the ref-update effect (line 91-92) and the
  // cleanup-effect (line 99) — it's belt-and-suspenders insurance against
  // future regressions weakening the abort semantics.
  it('discards probe results for targets no longer in the candidate set', async () => {
    let pollFn: () => Promise<unknown> = async () => undefined;
    vi.mocked(useVisibilityPolling).mockImplementation((cb) => { pollFn = cb; });

    let resolveProbe: (v: { result: string }) => void = () => {};
    const pending = new Promise<{ result: string }>((r) => { resolveProbe = r; });
    vi.mocked(resolveDnsViaDoh).mockReturnValue(pending as any);
    vi.mocked(probeHttps).mockReturnValue(pending as any);
    vi.mocked(computeStatus).mockReturnValue({ kind: 'pending_dns' } as any);

    const appWithTwo = makeApp({
      customDomains: [
        { serviceName: '', customDomain: 'kept.example.com' },
        { serviceName: '', customDomain: 'detached.example.com' },
      ],
    });
    mounted = mountWith([appWithTwo]);
    const pollPromise = pollFn();

    // Re-render with one domain removed. The detached entry must NOT show up
    // in any subsequent dnsStatuses write — either via abort (primary) or
    // via the merge-loop's defensive filter (belt-and-suspenders).
    const appWithOne = makeApp({
      customDomains: [{ serviceName: '', customDomain: 'kept.example.com' }],
    });
    flushSync(() => { mounted!.root.render(createElement(Wrapper, { apps: [appWithOne] })); });

    resolveProbe({ result: 'ok' });
    await pollPromise;

    const writtenKeys = setDnsStatuses.mock.calls.flatMap(
      (c) => Array.from((c[0] as Map<string, unknown>).keys()),
    );
    expect(writtenKeys).not.toContain('lease-1::detached.example.com');
  });

  // Fix #2 — registry-change pruning effect. See PR #93 Copilot 3243486930.
  //
  // Test A: direct prune on candidate-set shrink. When a domain is dropped
  // from the registry, the stale `dnsStatuses` entry for it must be evicted
  // by the reactive `useEffect([allTargets])` so future renders don't see a
  // ghost terminal row.
  it('prunes stale dnsStatuses entries when a domain is removed from the candidate set', () => {
    dnsStatuses = new Map([['lease-1::app.example.com', { kind: 'active' }]]);
    mounted = mountWith([makeApp()]);
    setDnsStatuses.mockClear();
    flushSync(() => {
      mounted!.root.render(createElement(Wrapper, { apps: [makeApp({ customDomains: [] })] }));
    });
    expect(setDnsStatuses).toHaveBeenCalledTimes(1);
    const pruned = setDnsStatuses.mock.calls[0][0] as Map<string, unknown>;
    expect(pruned.has('lease-1::app.example.com')).toBe(false);
  });

  // Test B (hero test for fix #2): canonical re-engagement after
  // clear-then-reattach of the same (lease, domain). Before the fix, the
  // stale terminal `active` entry from the prior attachment survived in
  // `dnsStatuses`. `hasNonTerminalTarget` (hook line ~81) read it on every
  // render, `useVisibilityPolling.enabled` stayed `false`, and the new
  // attachment was never re-verified — polling was disabled for the entire
  // duration of the trap. The reactive prune effect breaks the trap by
  // evicting the stale key when the candidate set goes empty.
  it('re-enables polling after clear-then-reattach of the same (lease, domain)', () => {
    dnsStatuses = new Map([['lease-1::app.example.com', { kind: 'active' }]]);
    mounted = mountWith([makeApp()]);
    // Initially trapped (stale active): polling should be disabled.
    let calls = vi.mocked(useVisibilityPolling).mock.calls;
    expect(calls[calls.length - 1][2]?.enabled).toBe(false);

    // Clear — pruning effect fires.
    flushSync(() => {
      mounted!.root.render(createElement(Wrapper, { apps: [makeApp({ customDomains: [] })] }));
    });
    // Simulate the slice update landing (mirrors existing test pattern).
    const prunedCall = setDnsStatuses.mock.calls[setDnsStatuses.mock.calls.length - 1][0] as Map<string, { kind: string }>;
    dnsStatuses = prunedCall;

    // Reattach the same domain.
    flushSync(() => { mounted!.root.render(createElement(Wrapper, { apps: [makeApp()] })); });

    calls = vi.mocked(useVisibilityPolling).mock.calls;
    expect(calls[calls.length - 1][2]?.enabled).toBe(true);
  });

  // Test C: no-op guard. Re-rendering with an unchanged candidate set (and
  // no missing entries to evict) must NOT call `setDnsStatuses` — otherwise
  // additive registry mutations would churn the store and re-render every
  // consumer on every render. Locks in operator's no-op guard amendment.
  it('does not call setDnsStatuses on re-render when the candidate set is unchanged', () => {
    dnsStatuses = new Map([['lease-1::app.example.com', { kind: 'pending_dns' }]]);
    const apps = [makeApp()];
    mounted = mountWith(apps);
    setDnsStatuses.mockClear();
    flushSync(() => { mounted!.root.render(createElement(Wrapper, { apps })); });
    expect(setDnsStatuses).not.toHaveBeenCalled();
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
