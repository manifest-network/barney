import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFaucetBaseUrl, isFaucetEnabled, requestFaucetTokens, FAUCET_COOLDOWN_HOURS } from './faucet';

vi.mock('../config/runtimeConfig', () => ({
  runtimeConfig: { PUBLIC_FAUCET_URL: 'http://localhost:8000' },
}));

vi.mock('./config', () => ({
  DENOMS: { MFX: 'umfx', PWR: 'factory/addr/upwr' },
}));

vi.mock('./utils', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

describe('FAUCET_COOLDOWN_HOURS', () => {
  it('is 24', () => {
    expect(FAUCET_COOLDOWN_HOURS).toBe(24);
  });
});

describe('getFaucetBaseUrl', () => {
  it('returns the configured PUBLIC_FAUCET_URL', () => {
    expect(getFaucetBaseUrl()).toBe('http://localhost:8000');
  });
});

describe('isFaucetEnabled', () => {
  it('returns true when PUBLIC_FAUCET_URL is set', () => {
    expect(isFaucetEnabled()).toBe(true);
  });

  it('returns false when PUBLIC_FAUCET_URL is empty', async () => {
    const { runtimeConfig } = await import('../config/runtimeConfig');
    const original = runtimeConfig.PUBLIC_FAUCET_URL;
    (runtimeConfig as any).PUBLIC_FAUCET_URL = '';
    try {
      expect(isFaucetEnabled()).toBe(false);
    } finally {
      (runtimeConfig as any).PUBLIC_FAUCET_URL = original;
    }
  });
});

describe('requestFaucetTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  it('returns success for both denoms on 200 responses', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('ok'),
    } as Response);

    const { results } = await requestFaucetTokens('manifest1abc');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ denom: 'umfx', success: true });
    expect(results[1]).toEqual({ denom: 'factory/addr/upwr', success: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('sends correct POST body for each denom', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('ok'),
    } as Response);

    await requestFaucetTokens('manifest1xyz');

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls[0][0]).toContain('/credit');
    expect(calls[0][1]).toEqual(expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'manifest1xyz', denom: 'umfx' }),
    }));
    expect(calls[1][1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ address: 'manifest1xyz', denom: 'factory/addr/upwr' }),
    }));
  });

  it('returns failure with error message on non-ok response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: () => Promise.resolve('cooldown active'),
    } as Response);

    const { results } = await requestFaucetTokens('manifest1abc');
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('cooldown active');
    expect(results[1].success).toBe(false);
  });

  it('handles partial success (one ok, one fail)', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('ok') } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: () => Promise.resolve('cooldown active'),
      } as Response);

    const { results } = await requestFaucetTokens('manifest1abc');
    expect(results[0]).toEqual({ denom: 'umfx', success: true });
    expect(results[1].success).toBe(false);
    expect(results[1].error).toBe('cooldown active');
  });

  it('handles network error gracefully', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('Failed to fetch'));

    const { results } = await requestFaucetTokens('manifest1abc');
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('Failed to fetch');
    expect(results[1].success).toBe(false);
  });
});
