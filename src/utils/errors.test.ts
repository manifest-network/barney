import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logError, normalizeErrorPunctuation } from './errors';

describe('logError', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    // Note: import.meta.env.DEV is read-only in Vite, so we can't easily test
    // the production behavior. The test verifies DEV mode behavior.
  });

  it('logs error with context in dev mode', () => {
    // In test environment, DEV is typically true
    logError('TestContext', new Error('test'));
    // The function only logs in DEV mode, which is true during tests
    if (import.meta.env.DEV) {
      expect(consoleErrorSpy).toHaveBeenCalledWith('[TestContext]', expect.any(Error));
    }
  });

  it('logs string errors', () => {
    logError('StringError', 'something went wrong');
    if (import.meta.env.DEV) {
      expect(consoleErrorSpy).toHaveBeenCalledWith('[StringError]', 'something went wrong');
    }
  });
});

describe('normalizeErrorPunctuation', () => {
  it('passes through a string with no trailing period', () => {
    expect(normalizeErrorPunctuation('X')).toBe('X');
  });

  it('strips a single trailing period', () => {
    expect(normalizeErrorPunctuation('X.')).toBe('X');
  });

  it('strips multiple trailing periods (defensive)', () => {
    expect(normalizeErrorPunctuation('X..')).toBe('X');
    expect(normalizeErrorPunctuation('X.....')).toBe('X');
  });

  it('returns empty string unchanged', () => {
    expect(normalizeErrorPunctuation('')).toBe('');
  });

  it('only strips trailing periods, not internal ones', () => {
    expect(normalizeErrorPunctuation('X. final words.')).toBe('X. final words');
    expect(normalizeErrorPunctuation('a.b.c.')).toBe('a.b.c');
  });

  it('is idempotent on the already-stripped form', () => {
    const once = normalizeErrorPunctuation('Already stripped.');
    expect(normalizeErrorPunctuation(once)).toBe(once);
  });

  it('preserves a string of only periods as empty', () => {
    expect(normalizeErrorPunctuation('...')).toBe('');
  });
});
