import { useCallback, useRef, useMemo } from 'react';
import type { ChatMessage } from '../contexts/aiTypes';

/** Pure navigation logic, testable without React. */
export class InputHistory {
  private index = -1;
  private draft = '';

  navigateUp(history: string[], currentInput: string): string | null {
    if (history.length === 0) return null;

    if (this.index === -1) {
      this.draft = currentInput;
    }

    const nextIndex = this.index + 1;
    if (nextIndex >= history.length) return null;

    this.index = nextIndex;
    return history[history.length - 1 - nextIndex];
  }

  navigateDown(history: string[]): string | null {
    if (this.index <= -1) return null;

    const nextIndex = this.index - 1;
    this.index = nextIndex;

    if (nextIndex === -1) {
      return this.draft;
    }

    return history[history.length - 1 - nextIndex];
  }

  reset(): void {
    this.index = -1;
    this.draft = '';
  }
}

/**
 * Terminal-style arrow-up/down history navigation for chat input.
 *
 * Tracks an index into the list of past user messages and preserves
 * the in-progress draft so it's restored when the user arrows back down.
 */
export function useInputHistory(messages: ChatMessage[]) {
  const historyRef = useRef(new InputHistory());

  const userMessages = useMemo(
    () => messages.filter((m) => m.role === 'user').map((m) => m.content),
    [messages]
  );

  const navigateUp = useCallback(
    (currentInput: string): string | null =>
      historyRef.current.navigateUp(userMessages, currentInput),
    [userMessages]
  );

  const navigateDown = useCallback(
    (): string | null => historyRef.current.navigateDown(userMessages),
    [userMessages]
  );

  const reset = useCallback(() => historyRef.current.reset(), []);

  return { navigateUp, navigateDown, reset };
}
