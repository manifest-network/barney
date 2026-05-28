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

  it('re-issues a fetch after error', async () => {
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
    spy.mockRestore();
  });

  it('re-issues a fetch even from ready phase', async () => {
    vi.mocked(resolveSkuTiers).mockResolvedValue({ tiers: [SAMPLE_TIER], denomSymbol: 'PWR' });
    const store = createAIStore();
    await store.getState().loadSkuTiers();
    expect(store.getState().skuTiers.phase).toBe('ready');
    await store.getState().retrySkuTiers();
    expect(vi.mocked(resolveSkuTiers)).toHaveBeenCalledTimes(2);
  });
});
