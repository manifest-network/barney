import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFaucetBaseUrl, isFaucetEnabled, requestFaucetTokens, requestFaucetDrip, faucetDripAndVerify, FAUCET_COOLDOWN_HOURS } from './faucet';

const mockRuntimeConfig = vi.hoisted(() => ({ PUBLIC_FAUCET_URL: 'http://localhost:8000' }));
vi.mock('../config/runtimeConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/runtimeConfig')>();
  return { ...actual, runtimeConfig: mockRuntimeConfig };
});

vi.mock('./config', () => ({
  DENOMS: { MFX: 'umfx', PWR: 'factory/addr/upwr' },
}));

vi.mock('./utils', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('./bank', () => ({
  getBalance: vi.fn(),
}));

import { getBalance } from './bank';

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

  it('returns false when PUBLIC_FAUCET_URL is empty', () => {
    const original = mockRuntimeConfig.PUBLIC_FAUCET_URL;
    mockRuntimeConfig.PUBLIC_FAUCET_URL = '';
    try {
      expect(isFaucetEnabled()).toBe(false);
    } finally {
      mockRuntimeConfig.PUBLIC_FAUCET_URL = original;
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

describe('requestFaucetDrip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  it('returns success on 200 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: true, text: () => Promise.resolve('ok') } as Response);
    const result = await requestFaucetDrip('manifest1abc', 'umfx');
    expect(result).toEqual({ denom: 'umfx', success: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns failure on non-ok response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false, status: 429, statusText: 'Too Many Requests',
      text: () => Promise.resolve('cooldown active'),
    } as Response);
    const result = await requestFaucetDrip('manifest1abc', 'umfx');
    expect(result.success).toBe(false);
    expect(result.error).toBe('cooldown active');
  });

  it('passes abort signal to fetch', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: true, text: () => Promise.resolve('ok') } as Response);
    const controller = new AbortController();
    await requestFaucetDrip('manifest1abc', 'umfx', controller.signal);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][1]).toHaveProperty('signal', controller.signal);
  });

  it('re-throws AbortError', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await expect(requestFaucetDrip('manifest1abc', 'umfx')).rejects.toThrow('Aborted');
  });
});

describe('faucetDripAndVerify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  it('returns success when balance increases after drip', async () => {
    // Pre-drip balance
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '1000000' })
      // First poll — increased
      .mockResolvedValueOnce({ denom: 'umfx', amount: '2000000' });
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: true, text: () => Promise.resolve('ok') } as Response);

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 200 });
    expect(result).toEqual({ denom: 'umfx', success: true });
  });

  it('returns failure when drip HTTP request fails', async () => {
    vi.mocked(getBalance).mockResolvedValue({ denom: 'umfx', amount: '1000000' });
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false, status: 500, statusText: 'Internal Server Error',
      text: () => Promise.resolve('server error'),
    } as Response);

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 200 });
    expect(result.success).toBe(false);
    expect(result.error).toBe('server error');
    // Should not poll after failed drip
    expect(vi.mocked(getBalance)).toHaveBeenCalledTimes(1);
  });

  it('returns failure when balance does not increase within timeout', async () => {
    vi.mocked(getBalance).mockResolvedValue({ denom: 'umfx', amount: '1000000' });
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: true, text: () => Promise.resolve('ok') } as Response);

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 50 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
  });

  it('handles zero pre-drip balance', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '0' })
      .mockResolvedValueOnce({ denom: 'umfx', amount: '1000000' });
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: true, text: () => Promise.resolve('ok') } as Response);

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 200 });
    expect(result).toEqual({ denom: 'umfx', success: true });
  });

  it('uses BigInt for large amounts', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '9999999999999999' })
      .mockResolvedValueOnce({ denom: 'umfx', amount: '10000000000000000' });
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: true, text: () => Promise.resolve('ok') } as Response);

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 200 });
    expect(result).toEqual({ denom: 'umfx', success: true });
  });

  it('throws on abort signal', async () => {
    vi.mocked(getBalance).mockResolvedValue({ denom: 'umfx', amount: '1000000' });
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: true, text: () => Promise.resolve('ok') } as Response);

    const controller = new AbortController();
    controller.abort();
    await expect(
      faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 200, signal: controller.signal })
    ).rejects.toThrow('Aborted');
  });

  it('returns failure when pre-drip getBalance throws', async () => {
    vi.mocked(getBalance).mockRejectedValueOnce(new Error('network error'));

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 200 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to read balance');
    // Should not fire faucet drip
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns failure when pre-drip balance is non-numeric', async () => {
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'umfx', amount: 'NaN' });

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 200 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid pre-drip balance');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('tolerates transient polling errors and continues', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '1000000' })   // pre-drip
      .mockRejectedValueOnce(new Error('transient'))                   // first poll fails
      .mockResolvedValueOnce({ denom: 'umfx', amount: '2000000' });  // second poll succeeds
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: true, text: () => Promise.resolve('ok') } as Response);

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 200 });
    expect(result).toEqual({ denom: 'umfx', success: true });
    expect(vi.mocked(getBalance)).toHaveBeenCalledTimes(3);
  });
});
