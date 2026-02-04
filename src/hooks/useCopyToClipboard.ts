import { useState, useCallback, useRef, useEffect } from 'react';
import { COPY_FEEDBACK_DURATION_MS } from '../config/constants';

/**
 * Custom hook for copying text to clipboard with feedback state.
 * Tracks which button was clicked via an optional key so multiple
 * copy buttons can independently show their copied state, even when
 * they copy the same text.
 *
 * @param feedbackDuration - Duration in ms to show "copied" feedback (default: 2000ms)
 * @returns Object with `copied` state, `copiedKey`, `copyToClipboard` function, and `isCopied` helper
 */
export function useCopyToClipboard(feedbackDuration = COPY_FEEDBACK_DURATION_MS) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const copyToClipboard = useCallback(
    async (text: string, key?: string): Promise<boolean> => {
      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      try {
        await navigator.clipboard.writeText(text);
        setCopiedKey(key ?? text);

        // Set new timeout with cleanup reference
        timeoutRef.current = setTimeout(() => {
          setCopiedKey(null);
          timeoutRef.current = null;
        }, feedbackDuration);

        return true;
      } catch {
        return false;
      }
    },
    [feedbackDuration]
  );

  /** Check if a specific key (or value) was just copied */
  const isCopied = useCallback((key: string) => copiedKey === key, [copiedKey]);

  // Backward compatibility: `copied` is true if anything was copied
  const copied = copiedKey !== null;

  return { copied, copiedKey, copyToClipboard, isCopied };
}
