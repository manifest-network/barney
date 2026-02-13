/**
 * Streaming updates hook — RAF-throttled message updates during LLM streaming.
 * Batches rapid content updates into one state update per animation frame.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { ChatMessage } from '../contexts/aiTypes';

export function useStreamingUpdates(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  messagesRef: React.MutableRefObject<ChatMessage[]>
) {
  const pendingUpdateRef = useRef<{
    messageId: string;
    content: string;
    thinking?: string;
  } | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  // Flush any pending streaming update immediately
  const flushPendingUpdate = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const pending = pendingUpdateRef.current;
    if (pending) {
      setMessages((prev) => {
        const updated = prev.map((m) =>
          m.id === pending.messageId
            ? { ...m, content: pending.content, thinking: pending.thinking || undefined }
            : m
        );
        messagesRef.current = updated;
        return updated;
      });
      pendingUpdateRef.current = null;
    }
  }, [setMessages, messagesRef]);

  // Schedule a throttled update for streaming content (once per animation frame)
  const scheduleStreamingUpdate = useCallback((messageId: string, content: string, thinking?: string) => {
    pendingUpdateRef.current = { messageId, content, thinking };

    if (!rafIdRef.current) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        const pending = pendingUpdateRef.current;
        if (pending) {
          setMessages((prev) => {
            const updated = prev.map((m) =>
              m.id === pending.messageId
                ? { ...m, content: pending.content, thinking: pending.thinking || undefined }
                : m
            );
            messagesRef.current = updated;
            return updated;
          });
          pendingUpdateRef.current = null;
        }
      });
    }
  }, [setMessages, messagesRef]);

  return { scheduleStreamingUpdate, flushPendingUpdate };
}
