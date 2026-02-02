import { useState, useCallback, useRef, useEffect } from 'react';
import { COPY_FEEDBACK_DURATION_MS } from '../config/constants';

/**
 * Custom hook for copying text to clipboard with feedback state.
 * Tracks which specific value was copied so multiple copy buttons
 * can independently show their copied state.
 *
 * @param feedbackDuration - Duration in ms to show "copied" feedback (default: 2000ms)
 * @returns Object with `copied` state, `copiedValue`, `copyToClipboard` function, and `isCopied` helper
 */
export function useCopyToClipboard(feedbackDuration = COPY_FEEDBACK_DURATION_MS) {
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
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
        setCopiedValue(text);

        // Set new timeout with cleanup reference
        timeoutRef.current = setTimeout(() => {
          setCopiedValue(null);
          timeoutRef.current = null;
        }, feedbackDuration);

        return true;
      } catch {
        return false;
      }
    },
    [feedbackDuration]
  );

  /** Check if a specific value was just copied */
  const isCopied = useCallback((text: string) => copiedValue === text, [copiedValue]);

  // Backward compatibility: `copied` is true if anything was copied
  const copied = copiedValue !== null;

  return { copied, copiedValue, copyToClipboard, isCopied };
}
