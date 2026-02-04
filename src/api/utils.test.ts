import { describe, it, expect, vi } from 'vitest';
import { withRetry } from './utils';

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient errors and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue('success');

    // Use very short delays for testing
    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 1 });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

    // Use very short delays for testing
    await expect(withRetry(fn, { maxRetries: 2, baseDelay: 1 })).rejects.toThrow('Failed to fetch');
    expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
  });

  it('does not retry on non-transient errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Validation failed'));

    await expect(withRetry(fn)).rejects.toThrow('Validation failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on AbortError', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    const fn = vi.fn().mockRejectedValue(abortError);

    await expect(withRetry(fn)).rejects.toThrow('Aborted');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
