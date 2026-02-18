import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scheduleStreamingUpdateFn, flushPendingUpdateFn } from './streaming';
import type { AIStore } from '../aiStore';
import type { ChatMessage } from '../../contexts/aiTypes';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg_1',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('streaming actions', () => {
  let state: Partial<AIStore>;
  let get: () => AIStore;
  let set: (partial: Partial<AIStore> | ((state: AIStore) => Partial<AIStore>)) => void;
  let rafCallbacks: Array<() => void>;

  beforeEach(() => {
    rafCallbacks = [];

    state = {
      messages: [makeMessage({ id: 'msg_1', content: '' })],
      _pendingStreamUpdate: null,
      _rafId: null,
    };

    get = () => state as AIStore;
    set = (partial) => {
      if (typeof partial === 'function') {
        Object.assign(state, partial(state as AIStore));
      } else {
        Object.assign(state, partial);
      }
    };

    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length; // return a fake id
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('scheduleStreamingUpdateFn', () => {
    it('stores pending update and schedules RAF', () => {
      scheduleStreamingUpdateFn(get, set, 'msg_1', 'hello');
      expect(state._pendingStreamUpdate).toEqual({
        messageId: 'msg_1',
        content: 'hello',
        thinking: undefined,
      });
      expect(state._rafId).toBe(1);
      expect(rafCallbacks).toHaveLength(1);
    });

    it('does not schedule a second RAF when one is pending', () => {
      scheduleStreamingUpdateFn(get, set, 'msg_1', 'first');
      scheduleStreamingUpdateFn(get, set, 'msg_1', 'second');
      expect(rafCallbacks).toHaveLength(1);
      // Latest content wins
      expect(state._pendingStreamUpdate!.content).toBe('second');
    });

    it('applies pending update when RAF fires', () => {
      scheduleStreamingUpdateFn(get, set, 'msg_1', 'streamed content');
      // Fire the RAF callback
      rafCallbacks[0]();
      expect(state.messages![0].content).toBe('streamed content');
      expect(state._pendingStreamUpdate).toBeNull();
      expect(state._rafId).toBeNull();
    });

    it('stores thinking content when provided', () => {
      scheduleStreamingUpdateFn(get, set, 'msg_1', 'content', 'thinking...');
      expect(state._pendingStreamUpdate!.thinking).toBe('thinking...');
    });
  });

  describe('flushPendingUpdateFn', () => {
    it('immediately applies pending update and cancels RAF', () => {
      state._pendingStreamUpdate = { messageId: 'msg_1', content: 'flushed' };
      state._rafId = 99;

      flushPendingUpdateFn(get, set);

      expect(cancelAnimationFrame).toHaveBeenCalledWith(99);
      expect(state.messages![0].content).toBe('flushed');
      expect(state._pendingStreamUpdate).toBeNull();
      expect(state._rafId).toBeNull();
    });

    it('clears RAF id even with no pending update', () => {
      state._rafId = 42;
      flushPendingUpdateFn(get, set);
      expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
      expect(state._rafId).toBeNull();
    });

    it('is a no-op when neither RAF nor pending update exist', () => {
      state._rafId = null;
      state._pendingStreamUpdate = null;
      flushPendingUpdateFn(get, set);
      // Messages should be unchanged
      expect(state.messages![0].content).toBe('');
    });
  });

  describe('coalescing', () => {
    it('only latest content is applied when multiple updates coalesce', () => {
      scheduleStreamingUpdateFn(get, set, 'msg_1', 'first');
      scheduleStreamingUpdateFn(get, set, 'msg_1', 'second');
      scheduleStreamingUpdateFn(get, set, 'msg_1', 'third');
      // Only one RAF was scheduled
      expect(rafCallbacks).toHaveLength(1);
      // Fire it
      rafCallbacks[0]();
      expect(state.messages![0].content).toBe('third');
    });
  });
});
