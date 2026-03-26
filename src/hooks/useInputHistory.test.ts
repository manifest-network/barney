import { describe, it, expect, beforeEach } from 'vitest';
import { InputHistory, stripAttachmentNote } from './useInputHistory';

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

  it('stays navigating during partial down-navigation', () => {
    const msgs = ['first', 'second', 'third'];

    history.navigateUp(msgs, '');
    history.navigateUp(msgs, 'third');
    history.navigateUp(msgs, 'second');

    history.navigateDown(msgs); // back to 'second'
    expect(history.isNavigating()).toBe(true);

    history.navigateDown(msgs); // back to 'third'
    expect(history.isNavigating()).toBe(true);

    history.navigateDown(msgs); // back to draft
    expect(history.isNavigating()).toBe(false);
  });

  it('remains navigating when navigateUp returns null at ceiling', () => {
    const msgs = ['only'];

    history.navigateUp(msgs, '');
    expect(history.navigateUp(msgs, 'only')).toBeNull();
    expect(history.isNavigating()).toBe(true);
  });

  it('is not navigating with empty history', () => {
    history.navigateUp([], '');
    expect(history.isNavigating()).toBe(false);
  });

  it('navigates through multi-line messages', () => {
    const msgs = ['single line', 'line one\nline two', 'another\nmulti\nline'];

    expect(history.navigateUp(msgs, '')).toBe('another\nmulti\nline');
    expect(history.navigateUp(msgs, 'another\nmulti\nline')).toBe('line one\nline two');
    expect(history.navigateUp(msgs, 'line one\nline two')).toBe('single line');

    expect(history.navigateDown(msgs)).toBe('line one\nline two');
    expect(history.navigateDown(msgs)).toBe('another\nmulti\nline');
    expect(history.navigateDown(msgs)).toBe('');
  });

  it('preserves multi-line draft', () => {
    const msgs = ['hello'];

    expect(history.navigateUp(msgs, 'my\nmulti-line\ndraft')).toBe('hello');
    expect(history.navigateDown(msgs)).toBe('my\nmulti-line\ndraft');
  });

  it('does not navigate down when not in history mode', () => {
    const msgs = ['first', 'second'];

    // Without navigating up first, navigateDown should always return null
    expect(history.navigateDown(msgs)).toBeNull();
    expect(history.navigateDown(msgs)).toBeNull();
  });

  it('supports immediate down-navigation after each up-navigation', () => {
    const msgs = ['first', 'second', 'third'];

    // Navigate up one step
    expect(history.navigateUp(msgs, '')).toBe('third');
    // Immediately navigate back down (simulates ArrowDown right after ArrowUp)
    expect(history.navigateDown(msgs)).toBe('');

    // Navigate up two steps
    expect(history.navigateUp(msgs, '')).toBe('third');
    expect(history.navigateUp(msgs, 'third')).toBe('second');
    // Immediately navigate back down
    expect(history.navigateDown(msgs)).toBe('third');
    expect(history.navigateDown(msgs)).toBe('');
  });

  it('clamps index when history shrinks during up-navigation', () => {
    const msgs = ['first', 'second', 'third'];

    // Navigate to oldest
    history.navigateUp(msgs, '');
    history.navigateUp(msgs, 'third');
    history.navigateUp(msgs, 'second'); // index=2, at 'first'

    // History shrinks (e.g., messages trimmed)
    const shorter = ['second', 'third'];
    // navigateUp should clamp and not return undefined
    expect(history.navigateUp(shorter, 'first')).toBeNull();
    // navigateDown should still work from clamped position
    expect(history.navigateDown(shorter)).toBe('third');
  });

  it('clamps index when history shrinks during down-navigation', () => {
    const msgs = ['first', 'second', 'third'];

    history.navigateUp(msgs, '');
    history.navigateUp(msgs, 'third');
    history.navigateUp(msgs, 'second'); // index=2

    // History shrinks to 1 entry
    const shorter = ['third'];
    expect(history.navigateDown(shorter)).toBe('');
  });

  it('resets when history becomes empty during navigation', () => {
    const msgs = ['first', 'second'];

    history.navigateUp(msgs, '');
    history.navigateUp(msgs, 'second'); // index=1

    // History cleared
    expect(history.navigateUp([], 'first')).toBeNull();
    expect(history.navigateDown([])).toBeNull();
  });
});

describe('stripAttachmentNote', () => {
  it('strips file attachment suffix', () => {
    expect(stripAttachmentNote('Deploy Hextris (File attached: manifest-hextris.json)')).toBe('Deploy Hextris');
  });

  it('leaves plain messages unchanged', () => {
    expect(stripAttachmentNote('deploy hextris')).toBe('deploy hextris');
  });

  it('handles auto-generated deploy message', () => {
    expect(stripAttachmentNote('Deploy this (File attached: stack.json)')).toBe('Deploy this');
  });

  it('returns empty string when message is only attachment note', () => {
    expect(stripAttachmentNote('(File attached: app.yaml)')).toBe('');
  });

  it('preserves parentheses in user text before attachment suffix', () => {
    expect(stripAttachmentNote('Deploy app (v2) (File attached: app.json)')).toBe('Deploy app (v2)');
  });

  it('handles filenames with parentheses', () => {
    expect(stripAttachmentNote('Deploy (File attached: file(1).json)')).toBe('Deploy');
  });

  it('handles filenames with spaces', () => {
    expect(stripAttachmentNote('Deploy (File attached: my manifest file.yaml)')).toBe('Deploy');
  });

  it('strips suffix from multi-line message', () => {
    expect(stripAttachmentNote('Deploy this\nwith config (File attached: app.json)')).toBe('Deploy this\nwith config');
  });
});
