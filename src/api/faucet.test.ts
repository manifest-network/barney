import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFaucetBaseUrl, isFaucetEnabled, faucetDripAndVerify, FAUCET_COOLDOWN_HOURS } from './faucet';

const mockRuntimeConfig = vi.hoisted(() => ({ PUBLIC_FAUCET_URL: 'http://localhost:8000' }));
vi.mock('../config/runtimeConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/runtimeConfig')>();
  return { ...actual, runtimeConfig: mockRuntimeConfig };
});

vi.mock('./bank', () => ({
  getBalance: vi.fn(),
}));

vi.mock('@manifest-network/manifest-mcp-chain', () => ({
  requestFaucetCredit: vi.fn(),
}));

import { getBalance } from './bank';
import { requestFaucetCredit } from '@manifest-network/manifest-mcp-chain';

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

describe('faucetDripAndVerify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success when balance increases after drip', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '1000000' })
      .mockResolvedValueOnce({ denom: 'umfx', amount: '2000000' });
    vi.mocked(requestFaucetCredit).mockResolvedValue({ denom: 'umfx', success: true });

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 200 });
    expect(result).toEqual({ denom: 'umfx', success: true });
    expect(requestFaucetCredit).toHaveBeenCalledWith('http://localhost:8000', 'manifest1abc', 'umfx');
  });

  it('returns failure when drip request fails', async () => {
    vi.mocked(getBalance).mockResolvedValue({ denom: 'umfx', amount: '1000000' });
    vi.mocked(requestFaucetCredit).mockResolvedValue({ denom: 'umfx', success: false, error: 'server error' });

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 200 });
    expect(result.success).toBe(false);
    expect(result.error).toBe('server error');
    // Should not poll after failed drip
    expect(vi.mocked(getBalance)).toHaveBeenCalledTimes(1);
  });

  it('returns failure when balance does not increase within timeout', async () => {
    vi.mocked(getBalance).mockResolvedValue({ denom: 'umfx', amount: '1000000' });
    vi.mocked(requestFaucetCredit).mockResolvedValue({ denom: 'umfx', success: true });

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 50 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
  });

  it('handles zero pre-drip balance', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '0' })
      .mockResolvedValueOnce({ denom: 'umfx', amount: '1000000' });
    vi.mocked(requestFaucetCredit).mockResolvedValue({ denom: 'umfx', success: true });

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 200 });
    expect(result).toEqual({ denom: 'umfx', success: true });
  });

  it('uses BigInt for large amounts', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '9999999999999999' })
      .mockResolvedValueOnce({ denom: 'umfx', amount: '10000000000000000' });
    vi.mocked(requestFaucetCredit).mockResolvedValue({ denom: 'umfx', success: true });

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 200 });
    expect(result).toEqual({ denom: 'umfx', success: true });
  });

  it('throws on abort signal', async () => {
    vi.mocked(getBalance).mockResolvedValue({ denom: 'umfx', amount: '1000000' });
    vi.mocked(requestFaucetCredit).mockResolvedValue({ denom: 'umfx', success: true });

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
    expect(requestFaucetCredit).not.toHaveBeenCalled();
  });

  it('returns failure when pre-drip balance is non-numeric', async () => {
    vi.mocked(getBalance).mockResolvedValueOnce({ denom: 'umfx', amount: 'NaN' });

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 200 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid pre-drip balance');
    expect(requestFaucetCredit).not.toHaveBeenCalled();
  });

  it('tolerates transient polling errors and continues', async () => {
    vi.mocked(getBalance)
      .mockResolvedValueOnce({ denom: 'umfx', amount: '1000000' })   // pre-drip
      .mockRejectedValueOnce(new Error('transient'))                   // first poll fails
      .mockResolvedValueOnce({ denom: 'umfx', amount: '2000000' });  // second poll succeeds
    vi.mocked(requestFaucetCredit).mockResolvedValue({ denom: 'umfx', success: true });

    const result = await faucetDripAndVerify('manifest1abc', 'umfx', { pollInterval: 10, pollTimeout: 200 });
    expect(result).toEqual({ denom: 'umfx', success: true });
    expect(vi.mocked(getBalance)).toHaveBeenCalledTimes(3);
  });
});
