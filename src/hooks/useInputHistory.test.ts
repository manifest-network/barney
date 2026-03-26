import { describe, it, expect, beforeEach } from 'vitest';
import { InputHistory } from './useInputHistory';

describe('InputHistory', () => {
  let history: InputHistory;

  beforeEach(() => {
    history = new InputHistory();
  });

  it('returns null when history is empty', () => {
    expect(history.navigateUp([], '')).toBeNull();
    expect(history.navigateDown([])).toBeNull();
  });

  it('navigates up through messages in reverse order', () => {
    const msgs = ['first', 'second', 'third'];

    expect(history.navigateUp(msgs, '')).toBe('third');
    expect(history.navigateUp(msgs, 'third')).toBe('second');
    expect(history.navigateUp(msgs, 'second')).toBe('first');
    // Already at oldest
    expect(history.navigateUp(msgs, 'first')).toBeNull();
  });

  it('navigates down and restores draft', () => {
    const msgs = ['first', 'second'];

    expect(history.navigateUp(msgs, 'my draft')).toBe('second');
    expect(history.navigateUp(msgs, 'second')).toBe('first');

    expect(history.navigateDown(msgs)).toBe('second');
    expect(history.navigateDown(msgs)).toBe('my draft');
    // Already at bottom
    expect(history.navigateDown(msgs)).toBeNull();
  });

  it('resets index and draft', () => {
    const msgs = ['hello'];

    expect(history.navigateUp(msgs, 'draft')).toBe('hello');

    history.reset();

    expect(history.navigateDown(msgs)).toBeNull();
    // Navigate up starts fresh with new draft
    expect(history.navigateUp(msgs, 'new draft')).toBe('hello');
    expect(history.navigateDown(msgs)).toBe('new draft');
  });

  it('handles single message', () => {
    const msgs = ['only'];

    expect(history.navigateUp(msgs, '')).toBe('only');
    expect(history.navigateUp(msgs, 'only')).toBeNull();
    expect(history.navigateDown(msgs)).toBe('');
  });

  it('preserves draft as empty string', () => {
    const msgs = ['msg'];

    expect(history.navigateUp(msgs, '')).toBe('msg');
    expect(history.navigateDown(msgs)).toBe('');
  });

  it('works with messages added after navigation', () => {
    const msgs1 = ['first'];
    expect(history.navigateUp(msgs1, '')).toBe('first');

    history.reset();

    const msgs2 = ['first', 'second'];
    expect(history.navigateUp(msgs2, '')).toBe('second');
    expect(history.navigateUp(msgs2, 'second')).toBe('first');
  });

  it('reports navigation state via isNavigating', () => {
    const msgs = ['first', 'second'];

    expect(history.isNavigating()).toBe(false);

    history.navigateUp(msgs, '');
    expect(history.isNavigating()).toBe(true);

    history.navigateDown(msgs);
    expect(history.isNavigating()).toBe(false);
  });

  it('resets navigation state on reset', () => {
    const msgs = ['first'];

    history.navigateUp(msgs, '');
    expect(history.isNavigating()).toBe(true);

    history.reset();
    expect(history.isNavigating()).toBe(false);
  });
});
