import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useVisibilityPolling } from './useVisibilityPolling';

// Helper: render a component that calls the hook, return cleanup
function renderHook(
  callback: () => Promise<boolean | void>,
  intervalMs: number,
  options?: Parameters<typeof useVisibilityPolling>[2],
): { unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function TestComponent() {
    useVisibilityPolling(callback, intervalMs, options);
    return null;
  }

  flushSync(() => {
    root.render(createElement(TestComponent));
  });

  return {
    unmount() {
      flushSync(() => { root.unmount(); });
      container.remove();
    },
  };
}

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    value: hidden,
    writable: true,
    configurable: true,
  });
}

function fireVisibilityChange() {
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useVisibilityPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setDocumentHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    setDocumentHidden(false);
  });

  it('calls callback immediately on mount when immediate is true (default)', async () => {
    const cb = vi.fn().mockResolvedValue(true);
    renderHook(cb, 10_000);

    // The immediate tick is async — flush microtasks
    await vi.advanceTimersByTimeAsync(0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not call callback on mount when immediate is false', async () => {
    const cb = vi.fn().mockResolvedValue(true);
    renderHook(cb, 10_000, { immediate: false });

    await vi.advanceTimersByTimeAsync(0);
    expect(cb).not.toHaveBeenCalled();

    // Should fire after intervalMs
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('calls callback at the specified interval', async () => {
    const cb = vi.fn().mockResolvedValue(true);
    renderHook(cb, 5_000);

    // immediate tick
    await vi.advanceTimersByTimeAsync(0);
    expect(cb).toHaveBeenCalledTimes(1);

    // first interval tick
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cb).toHaveBeenCalledTimes(2);

    // second interval tick
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('pauses when document becomes hidden', async () => {
    const cb = vi.fn().mockResolvedValue(true);
    renderHook(cb, 5_000);

    await vi.advanceTimersByTimeAsync(0); // immediate
    expect(cb).toHaveBeenCalledTimes(1);

    // Hide the tab
    setDocumentHidden(true);
    fireVisibilityChange();

    // Advance well past the interval — should NOT fire
    await vi.advanceTimersByTimeAsync(20_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('resumes and fires immediately on visibility restore', async () => {
    const cb = vi.fn().mockResolvedValue(true);
    renderHook(cb, 5_000);

    await vi.advanceTimersByTimeAsync(0); // immediate
    expect(cb).toHaveBeenCalledTimes(1);

    // Hide then show
    setDocumentHidden(true);
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(10_000);

    setDocumentHidden(false);
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(0); // flush the immediate tick
    expect(cb).toHaveBeenCalledTimes(2);

    // Should resume normal interval
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('applies exponential backoff on consecutive failures', async () => {
    const cb = vi.fn().mockResolvedValue(false);
    renderHook(cb, 1_000, { backoff: true, maxBackoffMultiplier: 8 });

    // immediate: failure 1
    await vi.advanceTimersByTimeAsync(0);
    expect(cb).toHaveBeenCalledTimes(1);

    // After 1 failure: delay = 1000 * 2^1 = 2000ms
    await vi.advanceTimersByTimeAsync(1_999);
    expect(cb).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cb).toHaveBeenCalledTimes(2);

    // After 2 failures: delay = 1000 * 2^2 = 4000ms
    await vi.advanceTimersByTimeAsync(3_999);
    expect(cb).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('caps backoff at maxBackoffMultiplier', async () => {
    const cb = vi.fn().mockResolvedValue(false);
    renderHook(cb, 1_000, { backoff: true, maxBackoffMultiplier: 4 });

    // immediate: failure 1
    await vi.advanceTimersByTimeAsync(0);

    // failure 1 → delay 2s
    await vi.advanceTimersByTimeAsync(2_000);
    // failure 2 → delay 4s (capped at 4x)
    await vi.advanceTimersByTimeAsync(4_000);
    // failure 3 → still 4s (still capped)
    await vi.advanceTimersByTimeAsync(4_000);
    expect(cb).toHaveBeenCalledTimes(4);

    // Confirm next is also 4s, not 8s
    await vi.advanceTimersByTimeAsync(3_999);
    expect(cb).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(cb).toHaveBeenCalledTimes(5);
  });

  it('resets backoff on success', async () => {
    let shouldFail = true;
    const cb = vi.fn().mockImplementation(async () => {
      if (shouldFail) return false;
      return true;
    });
    renderHook(cb, 1_000, { backoff: true });

    // immediate: fail
    await vi.advanceTimersByTimeAsync(0);
    // delay 2s after 1 failure
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cb).toHaveBeenCalledTimes(2);

    // Next one succeeds
    shouldFail = false;
    // delay 4s after 2 failures
    await vi.advanceTimersByTimeAsync(4_000);
    expect(cb).toHaveBeenCalledTimes(3);

    // After success, delay should be back to base 1s
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cb).toHaveBeenCalledTimes(4);
  });

  it('resets backoff on visibility restore', async () => {
    const cb = vi.fn().mockResolvedValue(false);
    renderHook(cb, 1_000, { backoff: true });

    // immediate: fail
    await vi.advanceTimersByTimeAsync(0);
    // 1 failure → delay 2s, fire again
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cb).toHaveBeenCalledTimes(2);

    // Hide tab, then restore
    setDocumentHidden(true);
    fireVisibilityChange();

    setDocumentHidden(false);
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(cb).toHaveBeenCalledTimes(3);

    // After visibility restore, backoff is reset — next delay is base (1s)
    // because the visibility-restore tick itself was a failure, so 1 failure → 2s
    // (reset to 0, then incremented by the failure)
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cb).toHaveBeenCalledTimes(4);
  });

  it('does not fire when enabled is false', async () => {
    const cb = vi.fn().mockResolvedValue(true);
    renderHook(cb, 1_000, { enabled: false });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('cleans up interval and listener on unmount', async () => {
    const cb = vi.fn().mockResolvedValue(true);
    const { unmount } = renderHook(cb, 5_000);

    await vi.advanceTimersByTimeAsync(0); // immediate
    expect(cb).toHaveBeenCalledTimes(1);

    unmount();

    // Should not fire after unmount
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not schedule while tab is hidden (finally guard)', async () => {
    // Simulate: callback starts, tab hides mid-flight, callback completes
    let resolveCallback: () => void;
    const cb = vi.fn().mockImplementation(
      () => new Promise<boolean>((resolve) => {
        resolveCallback = () => resolve(true);
      }),
    );
    renderHook(cb, 5_000);

    // Start the immediate tick (callback now in-flight)
    await vi.advanceTimersByTimeAsync(0);
    expect(cb).toHaveBeenCalledTimes(1);

    // Hide tab while callback is in-flight
    setDocumentHidden(true);
    fireVisibilityChange();

    // Resolve the callback — finally block should NOT schedule (doc is hidden)
    resolveCallback!();
    await vi.advanceTimersByTimeAsync(0);

    // Advance time — no new calls should happen
    await vi.advanceTimersByTimeAsync(20_000);
    expect(cb).toHaveBeenCalledTimes(1);

    // Show tab — should fire now
    setDocumentHidden(false);
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('prevents overlapping calls with in-flight guard', async () => {
    let resolveCallback: () => void;
    const cb = vi.fn().mockImplementation(
      () => new Promise<boolean>((resolve) => {
        resolveCallback = () => resolve(true);
      }),
    );
    renderHook(cb, 1_000, { immediate: false });

    // First tick starts
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cb).toHaveBeenCalledTimes(1);

    // Tab hides and shows while in-flight — should NOT fire again
    setDocumentHidden(true);
    fireVisibilityChange();
    setDocumentHidden(false);
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(0);
    // Still only 1 call because inFlight is true
    expect(cb).toHaveBeenCalledTimes(1);

    // Resolve the in-flight callback
    resolveCallback!();
    await vi.advanceTimersByTimeAsync(0);

    // Now it should schedule the next tick
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('handles callback errors gracefully', async () => {
    const cb = vi.fn().mockRejectedValue(new Error('boom'));
    renderHook(cb, 5_000, { context: 'test.error' });

    // Should not throw — error is caught and logged
    await vi.advanceTimersByTimeAsync(0);
    expect(cb).toHaveBeenCalledTimes(1);

    // Should continue polling after error
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
