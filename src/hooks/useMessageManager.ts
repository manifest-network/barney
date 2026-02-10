/**
 * Message manager hook — CRUD helpers for chat messages.
 * Maintains a synchronous ref mirror of messages state for safe access in async operations.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { ChatMessage } from '../contexts/aiTypes';
import { AI_MAX_MESSAGES } from '../config/constants';

/** Generate a unique message ID */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function useMessageManager(
  messages: ChatMessage[],
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
) {
  // Ref to track current messages for synchronous access in async operations
  const messagesRef = useRef<ChatMessage[]>([]);

  // Keep messagesRef in sync with messages state
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Trim messages to AI_MAX_MESSAGES limit (keeps most recent)
  const trimMessages = useCallback((msgs: ChatMessage[]): ChatMessage[] => {
    if (msgs.length <= AI_MAX_MESSAGES) return msgs;
    return msgs.slice(-AI_MAX_MESSAGES);
  }, []);

  // Helper to add a new message
  // Updates ref synchronously BEFORE setMessages to avoid race conditions
  const addMessage = useCallback(
    (message: ChatMessage) => {
      const updated = trimMessages([...messagesRef.current, message]);
      messagesRef.current = updated;
      setMessages(updated);
    },
    [trimMessages, setMessages]
  );

  // Helper to update a message by ID
  // Updates ref synchronously BEFORE setMessages to avoid race conditions
  const updateMessageById = useCallback(
    (messageId: string, updates: Partial<ChatMessage>) => {
      const updated = messagesRef.current.map((m) => (m.id === messageId ? { ...m, ...updates } : m));
      messagesRef.current = updated;
      setMessages(updated);
    },
    [setMessages]
  );

  // Helper to get current messages (excluding a specific message ID)
  // Uses ref for synchronous access without setState anti-pattern
  const getCurrentMessages = useCallback(
    (excludeId?: string): ChatMessage[] => {
      const current = messagesRef.current;
      return excludeId ? current.filter((m) => m.id !== excludeId) : current;
    },
    []
  );

  // Helper to create an assistant message
  const createAssistantMessage = useCallback((): ChatMessage => {
    return {
      id: generateMessageId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };
  }, []);

  return {
    messagesRef,
    addMessage,
    updateMessageById,
    getCurrentMessages,
    createAssistantMessage,
  };
}
