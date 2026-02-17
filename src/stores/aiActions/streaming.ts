/**
 * Streaming actions — RAF-throttled message updates during LLM streaming.
 */

import type { AIStore } from '../aiStore';

type Get = () => AIStore;
type Set = (partial: Partial<AIStore> | ((state: AIStore) => Partial<AIStore>)) => void;

export function scheduleStreamingUpdateFn(
  get: Get,
  set: Set,
  messageId: string,
  content: string,
  thinking?: string
): void {
  // Store the pending update (overwrites any previous pending update;
  // the RAF callback will pick up the latest value)
  set({
    _pendingStreamUpdate: { messageId, content, thinking },
  });

  // Only schedule a new RAF if one isn't already pending
  if (!get()._rafId) {
    const rafId = requestAnimationFrame(() => {
      const current = get();
      const pending = current._pendingStreamUpdate;
      if (pending) {
        const updated = current.messages.map((m) =>
          m.id === pending.messageId
            ? { ...m, content: pending.content, thinking: pending.thinking || undefined }
            : m
        );
        set({
          messages: updated,
          _pendingStreamUpdate: null,
          _rafId: null,
        });
      } else {
        set({ _rafId: null });
      }
    });
    set({ _rafId: rafId });
  }
}

export function flushPendingUpdateFn(get: Get, set: Set): void {
  const { _rafId, _pendingStreamUpdate } = get();
  if (_rafId) {
    cancelAnimationFrame(_rafId);
  }
  if (_pendingStreamUpdate) {
    const pending = _pendingStreamUpdate;
    const updated = get().messages.map((m) =>
      m.id === pending.messageId
        ? { ...m, content: pending.content, thinking: pending.thinking || undefined }
        : m
    );
    set({
      messages: updated,
      _pendingStreamUpdate: null,
      _rafId: null,
    });
  } else {
    set({ _rafId: null });
  }
}
