import { useRef, useEffect, useCallback } from 'react';

/**
 * Manages auto-scroll behavior for a scrollable container.
 * Scrolls to bottom when new items arrive, but respects the user scrolling up.
 *
 * @param itemCount - Number of items in the list (triggers scroll check on change)
 * @returns Refs to attach to the container and the scroll-to-bottom sentinel element
 */
export function useAutoScroll(itemCount: number) {
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(itemCount);
  const userScrolledUpRef = useRef(false);

  const isNearBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    const threshold = 100;
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  }, []);

  const handleScroll = useCallback(() => {
    userScrolledUpRef.current = !isNearBottom();
  }, [isNearBottom]);

  useEffect(() => {
    const prevCount = prevCountRef.current;
    const isNewItem = itemCount > prevCount;
    prevCountRef.current = itemCount;

    if (isNewItem || !userScrolledUpRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
      if (isNewItem) {
        userScrolledUpRef.current = false;
      }
    }
  }, [itemCount]);

  return { containerRef, endRef, handleScroll };
}
