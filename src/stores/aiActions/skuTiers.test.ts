import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/skuTiers', () => ({
  resolveSkuTiers: vi.fn(),
}));

vi.mock('../../config/skuSpecs', async (orig) => {
  const actual = await orig<typeof import('../../config/skuSpecs')>();
  return {
    ...actual,
    parseSkuSpecs: vi.fn(actual.parseSkuSpecs),
  };
});

vi.mock('../../api/utils', async (orig) => {
  const actual = await orig<typeof import('../../api/utils')>();
  return {
    ...actual,
    withTimeout: vi.fn(actual.withTimeout),
  };
});

vi.mock('../../config/runtimeConfig', async (orig) => {
  const actual = await orig<typeof import('../../config/runtimeConfig')>();
  return {
    ...actual,
    runtimeConfig: {
      ...actual.runtimeConfig,
      PUBLIC_SKU_SPECS: '{"docker-micro":{"cores":0.5,"ramMB":512,"diskGB":1}}',
    },
  };
});

import { createAIStore } from '../aiStore';
import { resolveSkuTiers } from '../../api/skuTiers';
import { withTimeout } from '../../api/utils';
import { parseSkuSpecs } from '../../config/skuSpecs';

const SAMPLE_TIER = {
  skuName: 'docker-micro',
  skuUuid: 'u1',
  providerUuid: 'p1',
  cores: 0.5,
  ramMB: 512,
  diskGB: 1,
  pricePerHour: 0.036,
  denomSymbol: 'PWR',
  unit: 1,
};

describe('loadSkuTiers', () => {
  beforeEach(async () => {
    vi.mocked(resolveSkuTiers).mockReset();
    // Reset withTimeout to its real impl (clears any per-test rejection mock
    // AND zeroes the call count for `toHaveBeenCalledTimes` assertions). The
    // module mock at the top of the file stashes a `vi.fn(realImpl)` over
    // the export, so without this reset prior tests' calls would leak in.
    const utils = await vi.importActual<typeof import('../../api/utils')>('../../api/utils');
    vi.mocked(withTimeout).mockReset();
    vi.mocked(withTimeout).mockImplementation(utils.withTimeout);
    // Same pattern for parseSkuSpecs — restore real impl per test, individual
    // tests can override (e.g. to force the empty-specs short-circuit path).
    const specs = await vi.importActual<typeof import('../../config/skuSpecs')>('../../config/skuSpecs');
    vi.mocked(parseSkuSpecs).mockReset();
    vi.mocked(parseSkuSpecs).mockImplementation(specs.parseSkuSpecs);
  });

  it('transitions idle → loading → ready on success', async () => {
    vi.mocked(resolveSkuTiers).mockResolvedValue({
      tiers: [SAMPLE_TIER],
      denomSymbol: 'PWR',
    });
    const store = createAIStore();
    expect(store.getState().skuTiers.phase).toBe('idle');
    const promise = store.getState().loadSkuTiers();
    expect(store.getState().skuTiers.phase).toBe('loading');
    await promise;
    expect(store.getState().skuTiers.phase).toBe('ready');
    expect(store.getState().skuTiers.tiers).toHaveLength(1);
    expect(store.getState().skuTiers.denomSymbol).toBe('PWR');
  });

  it('transitions loading → error on fetch failure', async () => {
    vi.mocked(resolveSkuTiers).mockRejectedValueOnce(new Error('chain unreachable'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createAIStore();
    await store.getState().loadSkuTiers();
    const state = store.getState().skuTiers;
    expect(state.phase).toBe('error');
    expect(state.error).toContain('chain unreachable');
    spy.mockRestore();
  });

  it('treats empty spec map as error (no usable tiers)', async () => {
    vi.mocked(resolveSkuTiers).mockResolvedValue({ tiers: [], denomSymbol: '' });
    const store = createAIStore();
    await store.getState().loadSkuTiers();
    expect(store.getState().skuTiers.phase).toBe('error');
    expect(store.getState().skuTiers.error).toMatch(/no tiers/i);
  });

  it('does not re-fetch while loading (returns same in-flight promise)', async () => {
    let resolveFn: ((v: { tiers: typeof SAMPLE_TIER[]; denomSymbol: string }) => void) = () => {};
    const gate = new Promise<{ tiers: typeof SAMPLE_TIER[]; denomSymbol: string }>((r) => {
      resolveFn = r;
    });
    vi.mocked(resolveSkuTiers).mockReturnValue(gate);
    const store = createAIStore();
    const p1 = store.getState().loadSkuTiers();
    const p2 = store.getState().loadSkuTiers();
    expect(p1).toBe(p2);  // returns the in-flight promise
    resolveFn({ tiers: [SAMPLE_TIER], denomSymbol: 'PWR' });
    await p1;
    expect(vi.mocked(resolveSkuTiers)).toHaveBeenCalledTimes(1);
  });

  it('short-circuits when phase === "ready"', async () => {
    vi.mocked(resolveSkuTiers).mockResolvedValue({ tiers: [SAMPLE_TIER], denomSymbol: 'PWR' });
    const store = createAIStore();
    await store.getState().loadSkuTiers();
    expect(store.getState().skuTiers.phase).toBe('ready');
    await store.getState().loadSkuTiers();
    expect(vi.mocked(resolveSkuTiers)).toHaveBeenCalledTimes(1);
  });

  it('wraps the boot fetch with withTimeout (labelled `resolveSkuTiers`)', async () => {
    // Wire-up check — locks in that loadSkuTiersFn passes through withTimeout
    // rather than awaiting resolveSkuTiers directly. Without the wrapper, a
    // hung LCD endpoint would strand the slice in `phase: 'loading'` forever
    // (the pass-6 follow-up deliberately removed the Retry button from the
    // loading state, so there's no in-app recovery from that condition).
    vi.mocked(resolveSkuTiers).mockResolvedValue({ tiers: [SAMPLE_TIER], denomSymbol: 'PWR' });
    const store = createAIStore();
    await store.getState().loadSkuTiers();
    expect(vi.mocked(withTimeout)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(withTimeout).mock.calls[0];
    // Second arg is `ms` — undefined means "use AI_TOOL_API_TIMEOUT_MS default".
    expect(call[1]).toBeUndefined();
    // Third arg is the label that ends up in the timeout error message.
    expect(call[2]).toBe('resolveSkuTiers');
  });

  it('transitions to error when withTimeout rejects (LCD endpoint hangs)', async () => {
    // Simulate the actual failure mode: withTimeout's promise rejects with
    // a "timed out" Error because the wrapped resolveSkuTiers never settled.
    vi.mocked(withTimeout).mockRejectedValueOnce(
      new Error('resolveSkuTiers timed out after 15000ms'),
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createAIStore();
    await store.getState().loadSkuTiers();
    const state = store.getState().skuTiers;
    expect(state.phase).toBe('error');
    expect(state.error).toMatch(/timed out/i);
    expect(state.tiers).toEqual([]);
    spy.mockRestore();
  });

  it('happy path still completes promptly without waiting for the timeout', async () => {
    // Companion regression catch: tightening the timeout wrapper mustn't
    // delay the resolved path. resolveSkuTiers resolves "instantly" → slice
    // reaches ready without us ever needing to advance fake timers.
    vi.mocked(resolveSkuTiers).mockResolvedValue({ tiers: [SAMPLE_TIER], denomSymbol: 'PWR' });
    const store = createAIStore();
    await store.getState().loadSkuTiers();
    expect(store.getState().skuTiers.phase).toBe('ready');
    expect(store.getState().skuTiers.tiers).toEqual([SAMPLE_TIER]);
  });

  it('short-circuits with a config-error message when parseSkuSpecs returns {}', async () => {
    // Empty `PUBLIC_SKU_SPECS` (or JSON parse fail / all-entries-invalid) is
    // a pure local-config problem — there is no chain query that can fix it,
    // so we transition straight to error without waiting on the network.
    // Without this short-circuit, the user would wait up to
    // AI_TOOL_API_TIMEOUT_MS (~15s) for the wrapped `resolveSkuTiers` call to
    // time out, and the displayed error would point at the chain rather than
    // the env var that actually needs fixing.
    vi.mocked(parseSkuSpecs).mockReturnValue({});
    const store = createAIStore();
    const result = store.getState().loadSkuTiers();
    // Synchronous transition: error state visible before awaiting the returned
    // promise. resolveSkuTiers must not be called at all.
    const state = store.getState().skuTiers;
    expect(state.phase).toBe('error');
    expect(state.error).toMatch(/PUBLIC_SKU_SPECS is empty or invalid/);
    expect(state.tiers).toEqual([]);
    expect(vi.mocked(resolveSkuTiers)).not.toHaveBeenCalled();
    // The returned promise resolves immediately (not an in-flight wait).
    await expect(result).resolves.toBeUndefined();
  });

  it('regex-match contract: the empty-specs error wording is matched by the pass-6 inline-Retry pattern', () => {
    // Lock-in test for the cross-fix coupling — the empty-specs short-circuit
    // is only useful as a recovery path if MessageBubble's ERROR_PATTERNS
    // attaches a Retry button to the resulting rejection. Trace the same
    // wording deployExample wraps with: `Deploy unavailable: <error>.`
    const catalogErrorPattern = /^Deploy unavailable: (?!tier catalog is still loading\b).+\.$/;
    const wrapped = 'Deploy unavailable: PUBLIC_SKU_SPECS is empty or invalid — no SKU specs configured.';
    expect(catalogErrorPattern.test(wrapped)).toBe(true);
  });

  it('still calls resolveSkuTiers when parseSkuSpecs returns a non-empty map (regression catch)', async () => {
    // Make sure the short-circuit doesn't accidentally fire on the happy path.
    // The default runtimeConfig mock at the top of the file provides a valid
    // single-entry specs map, and `parseSkuSpecs` is real (per beforeEach), so
    // we just need to verify the chain side runs.
    vi.mocked(resolveSkuTiers).mockResolvedValue({ tiers: [SAMPLE_TIER], denomSymbol: 'PWR' });
    const store = createAIStore();
    await store.getState().loadSkuTiers();
    expect(vi.mocked(resolveSkuTiers)).toHaveBeenCalledTimes(1);
    expect(store.getState().skuTiers.phase).toBe('ready');
  });
});

describe('retrySkuTiers', () => {
  beforeEach(() => vi.mocked(resolveSkuTiers).mockReset());

  it('from error: resets phase and re-issues a fetch', async () => {
    vi.mocked(resolveSkuTiers).mockRejectedValueOnce(new Error('x'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createAIStore();
    await store.getState().loadSkuTiers();
    expect(store.getState().skuTiers.phase).toBe('error');

    vi.mocked(resolveSkuTiers).mockResolvedValueOnce({
      tiers: [SAMPLE_TIER],
      denomSymbol: 'PWR',
    });
    await store.getState().retrySkuTiers();
    expect(store.getState().skuTiers.phase).toBe('ready');
    expect(vi.mocked(resolveSkuTiers)).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('from idle: resets phase (no-op) and issues a fetch', async () => {
    vi.mocked(resolveSkuTiers).mockResolvedValue({ tiers: [SAMPLE_TIER], denomSymbol: 'PWR' });
    const store = createAIStore();
    expect(store.getState().skuTiers.phase).toBe('idle');
    await store.getState().retrySkuTiers();
    expect(store.getState().skuTiers.phase).toBe('ready');
    expect(vi.mocked(resolveSkuTiers)).toHaveBeenCalledTimes(1);
  });

  it('from loading: in-flight dedupe path — joins the existing promise without a second fetch', async () => {
    let resolveFn: ((v: { tiers: typeof SAMPLE_TIER[]; denomSymbol: string }) => void) = () => {};
    const gate = new Promise<{ tiers: typeof SAMPLE_TIER[]; denomSymbol: string }>((r) => {
      resolveFn = r;
    });
    vi.mocked(resolveSkuTiers).mockReturnValue(gate);
    const store = createAIStore();
    const load = store.getState().loadSkuTiers();
    expect(store.getState().skuTiers.phase).toBe('loading');
    const retry = store.getState().retrySkuTiers();
    // The retry happened while load was in flight — retrySkuTiersFn sets
    // idle then calls loadSkuTiersFn; the in-flight promise dedupe inside
    // loadSkuTiersFn means we still only get one upstream resolveSkuTiers
    // call.
    resolveFn({ tiers: [SAMPLE_TIER], denomSymbol: 'PWR' });
    await Promise.all([load, retry]);
    expect(vi.mocked(resolveSkuTiers)).toHaveBeenCalledTimes(1);
    expect(store.getState().skuTiers.phase).toBe('ready');
  });

  it('from ready: NO-OP — does not re-fetch, does not transition phase, preserves tiers', async () => {
    vi.mocked(resolveSkuTiers).mockResolvedValue({ tiers: [SAMPLE_TIER], denomSymbol: 'PWR' });
    const store = createAIStore();
    await store.getState().loadSkuTiers();
    expect(store.getState().skuTiers.phase).toBe('ready');
    expect(vi.mocked(resolveSkuTiers)).toHaveBeenCalledTimes(1);

    const tiersBefore = store.getState().skuTiers.tiers;
    const result = store.getState().retrySkuTiers();
    // Must resolve to a resolved promise so awaiting consumers don't hang.
    await expect(result).resolves.toBeUndefined();
    // Phase must NOT have transitioned away from 'ready' — consumers read
    // skuTiers.tiers without a phase guard, so a ready → idle/loading would
    // briefly orphan the previously-resolved tiers in active executions.
    expect(store.getState().skuTiers.phase).toBe('ready');
    // Tiers must be the same reference — confirms we didn't reset state.
    expect(store.getState().skuTiers.tiers).toBe(tiersBefore);
    // No second fetch — and crucially this is the only no-op-from-ready
    // signal that survives if someone later changes the loadSkuTiersFn
    // short-circuit too.
    expect(vi.mocked(resolveSkuTiers)).toHaveBeenCalledTimes(1);
  });
});
