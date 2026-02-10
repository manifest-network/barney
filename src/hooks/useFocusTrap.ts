import { useRef, useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"]):not(:disabled)',
].join(', ');

interface UseFocusTrapOptions {
  /** Called when Escape is pressed inside the trap. */
  onEscape?: () => void;
  /** Element to focus when the trap activates. Falls back to the container. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Traps keyboard focus within a container element.
 *
 * - Tab / Shift+Tab cycle through focusable children, wrapping at boundaries
 * - Escape calls the provided `onEscape` callback
 * - Focus is restored to the previously-focused element on deactivation
 * - Hidden and disabled elements are excluded from the cycle
 *
 * @param active - Whether the trap is currently active
 * @param options - Configuration for escape handling and initial focus
 * @returns A ref to attach to the container element (must have tabIndex={-1})
 */
export function useFocusTrap(active: boolean, options: UseFocusTrapOptions = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const onEscapeRef = useRef(options.onEscape);

  // Keep onEscape ref current without re-running the effect
  useEffect(() => {
    onEscapeRef.current = options.onEscape;
  });

  useEffect(() => {
    if (!active) return;

    previousActiveElement.current = document.activeElement as HTMLElement;

    // Focus initial target or fall back to container
    if (options.initialFocusRef?.current) {
      options.initialFocusRef.current.focus();
    } else {
      containerRef.current?.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onEscapeRef.current?.();
        return;
      }

      if (e.key !== 'Tab') return;

      const container = containerRef.current;
      if (!container) return;

      // Query focusable elements, excluding hidden ones
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => el.offsetParent !== null);

      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);

      if (e.shiftKey) {
        // Shift+Tab from first element (or outside the focusable set) → last
        if (currentIndex <= 0) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab from last element (or outside the focusable set) → first
        if (currentIndex === -1 || currentIndex === focusable.length - 1) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousActiveElement.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return containerRef;
}
