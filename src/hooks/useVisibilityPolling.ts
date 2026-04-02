/**
 * useVisibilityPolling — visibility-aware polling with optional exponential backoff.
 *
 * Pauses when the tab is hidden, resumes + fires immediately on tab focus.
 * Uses setTimeout chains (not setInterval) for variable backoff delays.
 */

import { useEffect, useRef } from 'react';
import { logError } from '../utils/errors';

export interface UseVisibilityPollingOptions {
  /** Enable exponential backoff on consecutive failures (default: false) */
  backoff?: boolean;
  /** Maximum backoff multiplier — caps interval at baseInterval * multiplier (default: 8) */
  maxBackoffMultiplier?: number;
  /** Fire callback immediately on mount / when enabled becomes true (default: true) */
  immediate?: boolean;
  /** When false, no timers run (default: true) */
  enabled?: boolean;
  /** Context string for logError (default: 'useVisibilityPolling') */
  context?: string;
}

/**
 * Poll with visibility awareness and optional backoff.
 *
 * @param callback — async function to poll. Return `false` to signal failure
 *   (triggers backoff when enabled). Return `true` or `void` to signal success.
 *   Callers do not need to memoize the callback — it is stored in a ref.
 * @param intervalMs — base polling interval in milliseconds
 * @param options — optional settings (object identity may change freely)
 */
export function useVisibilityPolling(
  callback: () => Promise<boolean | void>,
  intervalMs: number,
  options?: UseVisibilityPollingOptions,
): void {
  // Extract enabled as a primitive for the dep array.
  // Other options stay in the ref (never in deps).
  const enabled = options?.enabled ?? true;

  const callbackRef = useRef(callback);
  const optionsRef = useRef(options);

  // Sync callback ref — declared before the main effect so React fires it first
  // on simultaneous changes, ensuring the main effect reads the updated ref.
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  // Sync options ref (no dep array — runs after every render).
  // Must be in useEffect, not render body — eslint-plugin-react-hooks@7 flags
  // render-body ref writes for variables ending in `Ref`.
  useEffect(() => {
    optionsRef.current = options;
  });

  // Main polling effect — only intervalMs and enabled drive re-initialization.
  useEffect(() => {
    if (!enabled) return;

    let isMounted = true;
    let consecutiveFailures = 0;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    // Read options from ref on each use so callers can change them freely
    // without restarting the timer (e.g., toggling backoff at runtime).
    function getOpts() {
      const opts = optionsRef.current;
      return {
        shouldBackoff: opts?.backoff ?? false,
        maxMultiplier: opts?.maxBackoffMultiplier ?? 8,
        context: opts?.context ?? 'useVisibilityPolling',
      };
    }

    function getDelay(): number {
      const { shouldBackoff, maxMultiplier } = getOpts();
      if (!shouldBackoff || consecutiveFailures === 0) return intervalMs;
      const multiplier = Math.min(
        Math.pow(2, consecutiveFailures),
        maxMultiplier,
      );
      return intervalMs * multiplier;
    }

    function scheduleNext(): void {
      if (!isMounted) return;
      timeoutId = setTimeout(tick, getDelay());
    }

    async function tick(): Promise<void> {
      if (!isMounted || inFlight) return;
      inFlight = true;
      const { shouldBackoff, context } = getOpts();
      try {
        const result = await callbackRef.current();
        if (result === false && shouldBackoff) {
          consecutiveFailures++;
        } else if (shouldBackoff) {
          consecutiveFailures = 0;
        }
      } catch (err) {
        logError(context, err);
        if (shouldBackoff) consecutiveFailures++;
      } finally {
        inFlight = false;
        if (isMounted && !document.hidden) {
          scheduleNext();
        }
        // If document.hidden, the visibilitychange handler will restart
        // polling when the tab returns.
      }
    }

    function handleVisibilityChange(): void {
      if (document.hidden) {
        // Pause — clear any pending timeout
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      } else {
        // Resume — reset backoff and fire immediately (if not already in-flight).
        // When in-flight, the running tick will schedule the next one on completion.
        consecutiveFailures = 0;
        if (!inFlight) {
          tick();
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Initial fire — only start polling if the tab is currently visible
    if (!document.hidden) {
      const immediate = optionsRef.current?.immediate ?? true;
      if (immediate) {
        tick();
      } else {
        scheduleNext();
      }
    }

    return () => {
      isMounted = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };
  }, [intervalMs, enabled]);
}
