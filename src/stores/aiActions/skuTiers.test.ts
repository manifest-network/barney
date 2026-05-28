import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/skuTiers', () => ({
  resolveSkuTiers: vi.fn(),
}));

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
  beforeEach(() => vi.mocked(resolveSkuTiers).mockReset());

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
