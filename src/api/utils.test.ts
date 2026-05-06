import { describe, it, expect, vi } from 'vitest';
import { withRetry, withTimeout, throwIfAborted } from './utils';

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

describe('withTimeout', () => {
  it('resolves when promise settles before timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000);
    expect(result).toBe('ok');
  });

  it('rejects with timeout error when promise takes too long', async () => {
    const slow = new Promise(() => {}); // never resolves
    await expect(withTimeout(slow, 50, 'TestOp')).rejects.toThrow('TestOp timed out after 50ms');
  });

  it('propagates the original rejection if promise fails before timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });

  it('clears the timer when the promise resolves', async () => {
    vi.useFakeTimers();
    const p = withTimeout(Promise.resolve('done'), 5000);
    const result = await p;
    expect(result).toBe('done');
    // Advancing timers should not cause unhandled rejections
    vi.advanceTimersByTime(10000);
    vi.useRealTimers();
  });

  it('rejects with AbortError when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      withTimeout(new Promise(() => undefined), 5000, 'Test', ac.signal),
    ).rejects.toThrow(/aborted/i);
  });

  it('rejects with AbortError when the signal aborts mid-flight', async () => {
    const ac = new AbortController();
    const promise = withTimeout(new Promise(() => undefined), 5000, 'Test', ac.signal);
    setTimeout(() => ac.abort(), 0);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves normally when signal never aborts', async () => {
    const ac = new AbortController();
    const result = await withTimeout(Promise.resolve('done'), 5000, 'Test', ac.signal);
    expect(result).toBe('done');
  });

  it('removes the abort listener on success path (no leak across repeated calls)', async () => {
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, 'addEventListener');
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

    // 5 successful calls sharing one signal
    for (let i = 0; i < 5; i++) {
      await withTimeout(Promise.resolve(i), 5000, 'Test', ac.signal);
    }

    // Each attached listener must be detached.
    const abortAdds = addSpy.mock.calls.filter((c) => c[0] === 'abort');
    const abortRemoves = removeSpy.mock.calls.filter((c) => c[0] === 'abort');
    expect(abortAdds.length).toBe(5);
    expect(abortRemoves.length).toBe(5);
  });

  it('removes the abort listener on timeout path', async () => {
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

    await expect(
      withTimeout(new Promise(() => undefined), 1, 'Test', ac.signal),
    ).rejects.toThrow(/timed out/);

    const abortRemoves = removeSpy.mock.calls.filter((c) => c[0] === 'abort');
    expect(abortRemoves.length).toBe(1);
  });
});

describe('throwIfAborted', () => {
  it('is a no-op when signal is undefined', () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });

  it('is a no-op when signal is not aborted', () => {
    const ac = new AbortController();
    expect(() => throwIfAborted(ac.signal)).not.toThrow();
  });

  it('throws AbortError when signal is aborted', () => {
    const ac = new AbortController();
    ac.abort();
    expect(() => throwIfAborted(ac.signal, 'work')).toThrow(/work aborted/);
  });
});
