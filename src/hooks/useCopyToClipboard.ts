import { useState, useCallback, useRef, useEffect } from 'react';
import { COPY_FEEDBACK_DURATION_MS } from '../config/constants';

/**
 * Custom hook for copying text to clipboard with feedback state.
 * Properly cleans up timeouts on unmount to prevent memory leaks.
 *
 * @param feedbackDuration - Duration in ms to show "copied" feedback (default: 2000ms)
 * @returns Object with `copied` state and `copyToClipboard` function
 */
export function useCopyToClipboard(feedbackDuration = COPY_FEEDBACK_DURATION_MS) {
  const [copied, setCopied] = useState(false);
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
    async (text: string): Promise<boolean> => {
      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);

        // Set new timeout with cleanup reference
        timeoutRef.current = setTimeout(() => {
          setCopied(false);
          timeoutRef.current = null;
        }, feedbackDuration);

        return true;
      } catch {
        return false;
      }
    },
    [feedbackDuration]
  );

  return { copied, copyToClipboard };
}
