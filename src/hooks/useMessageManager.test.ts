import { describe, it, expect } from 'vitest';
import { generateMessageId } from './useMessageManager';
import type { ChatMessage } from '../contexts/aiTypes';
import { AI_MAX_MESSAGES } from '../config/constants';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: generateMessageId(),
    role: 'user',
    content: 'test',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Extracted logic from useMessageManager for testing without React context.
 * The hook's addMessage does: trimMessages([...messagesRef.current, message])
 * and updateMessageById does: messagesRef.current.map(m => m.id === id ? {...m, ...updates} : m)
 */
function trimMessages(msgs: ChatMessage[]): ChatMessage[] {
  if (msgs.length <= AI_MAX_MESSAGES) return msgs;
  return msgs.slice(-AI_MAX_MESSAGES);
}

function addMessage(current: ChatMessage[], message: ChatMessage): ChatMessage[] {
  return trimMessages([...current, message]);
}

function updateMessageById(
  current: ChatMessage[],
  messageId: string,
  updates: Partial<ChatMessage>
): ChatMessage[] {
  return current.map((m) => (m.id === messageId ? { ...m, ...updates } : m));
}

function getCurrentMessages(current: ChatMessage[], excludeId?: string): ChatMessage[] {
  return excludeId ? current.filter((m) => m.id !== excludeId) : current;
}

describe('generateMessageId', () => {
  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateMessageId()));
    expect(ids.size).toBe(100);
  });

  it('generates IDs with msg_ prefix', () => {
    expect(generateMessageId()).toMatch(/^msg_\d+_[a-z0-9]+$/);
  });
});

describe('useMessageManager logic', () => {
  describe('addMessage', () => {
    it('appends a message to the list', () => {
      const msg = makeMessage({ id: 'a', content: 'hello' });
      const result = addMessage([], msg);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('hello');
    });

    it('preserves existing messages', () => {
      const existing = [makeMessage({ id: 'a' })];
      const newMsg = makeMessage({ id: 'b' });
      const result = addMessage(existing, newMsg);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('a');
      expect(result[1].id).toBe('b');
    });

    it('trims to AI_MAX_MESSAGES keeping most recent', () => {
      const existing = Array.from({ length: AI_MAX_MESSAGES }, (_, i) =>
        makeMessage({ id: `msg-${i}`, content: `msg-${i}` })
      );
      const overflow = makeMessage({ id: 'overflow', content: 'overflow' });
      const result = addMessage(existing, overflow);

      expect(result).toHaveLength(AI_MAX_MESSAGES);
      // Oldest message should be gone
      expect(result[0].id).toBe('msg-1');
      // Newest should be the overflow
      expect(result[AI_MAX_MESSAGES - 1].id).toBe('overflow');
    });

    it('does not trim when under limit', () => {
      const existing = [makeMessage({ id: 'a' }), makeMessage({ id: 'b' })];
      const newMsg = makeMessage({ id: 'c' });
      const result = addMessage(existing, newMsg);
      expect(result).toHaveLength(3);
    });
  });

  describe('updateMessageById', () => {
    it('updates the correct message by ID', () => {
      const messages = [
        makeMessage({ id: 'a', content: 'original' }),
        makeMessage({ id: 'b', content: 'other' }),
      ];
      const result = updateMessageById(messages, 'a', { content: 'updated', isStreaming: false });

      expect(result[0].content).toBe('updated');
      expect(result[0].isStreaming).toBe(false);
      expect(result[1].content).toBe('other');
    });

    it('is a no-op for unknown IDs', () => {
      const messages = [makeMessage({ id: 'a', content: 'original' })];
      const result = updateMessageById(messages, 'nonexistent', { content: 'updated' });
      expect(result[0].content).toBe('original');
    });

    it('merges updates without replacing other fields', () => {
      const messages = [makeMessage({ id: 'a', content: 'hello', role: 'user' })];
      const result = updateMessageById(messages, 'a', { error: 'fail' });

      expect(result[0].content).toBe('hello');
      expect(result[0].role).toBe('user');
      expect(result[0].error).toBe('fail');
    });
  });

  describe('getCurrentMessages', () => {
    it('returns all messages without filter', () => {
      const messages = [makeMessage({ id: 'a' }), makeMessage({ id: 'b' })];
      expect(getCurrentMessages(messages)).toHaveLength(2);
    });

    it('excludes a specific message by ID', () => {
      const messages = [makeMessage({ id: 'a' }), makeMessage({ id: 'b' })];
      const result = getCurrentMessages(messages, 'a');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('b');
    });

    it('returns all messages if excludeId does not match', () => {
      const messages = [makeMessage({ id: 'a' })];
      expect(getCurrentMessages(messages, 'nonexistent')).toHaveLength(1);
    });
  });

  describe('rapid sequential adds (simulating ref-based sync)', () => {
    it('ref stays consistent across multiple adds', () => {
      // Simulates the ref-based pattern: each addMessage reads from ref,
      // writes back to ref synchronously, then calls setMessages
      let ref: ChatMessage[] = [];

      const msg1 = makeMessage({ id: 'a', content: 'first' });
      ref = addMessage(ref, msg1);

      const msg2 = makeMessage({ id: 'b', content: 'second' });
      ref = addMessage(ref, msg2);

      const msg3 = makeMessage({ id: 'c', content: 'third' });
      ref = addMessage(ref, msg3);

      expect(ref).toHaveLength(3);
      expect(ref.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });
  });
});
