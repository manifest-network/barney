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

  // Scroll during streaming as content grows.
  // Throttled to one scroll per animation frame to avoid compounding smooth-scroll animations.
  useEffect(() => {
    if (!isStreaming || userScrolledUpRef.current) return;

    const container = containerRef.current;
    if (!container) return;

    let rafId: number | null = null;

    const observer = new MutationObserver(() => {
      if (userScrolledUpRef.current || rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        endRef.current?.scrollIntoView({ behavior: 'auto' });
      });
    });

    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [isStreaming]);

  const scrollToBottom = useCallback(() => {
    if (!userScrolledUpRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  return { containerRef, endRef, handleScroll, scrollToBottom };
}
