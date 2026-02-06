import { useRef, useEffect, useCallback } from 'react';

/**
 * Manages auto-scroll behavior for a scrollable container.
 * Scrolls to bottom when new items arrive or content is streaming,
 * but respects the user scrolling up.
 *
 * @param itemCount - Number of items in the list (triggers scroll check on change)
 * @param isStreaming - Whether content is actively streaming (triggers continuous scroll)
 * @returns Refs to attach to the container and the scroll-to-bottom sentinel element
 */
export function useAutoScroll(itemCount: number, isStreaming?: boolean) {
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

  // Scroll on new messages
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

  // Scroll during streaming as content grows
  useEffect(() => {
    if (!isStreaming || userScrolledUpRef.current) return;

    const container = containerRef.current;
    if (!container) return;

    const observer = new MutationObserver(() => {
      if (!userScrolledUpRef.current) {
        endRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    });

    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [isStreaming]);

  return { containerRef, endRef, handleScroll };
}
