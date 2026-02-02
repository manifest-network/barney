import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getErrorMessage, logError, handleError } from './errors';

describe('getErrorMessage', () => {
  it('extracts message from Error instance', () => {
    expect(getErrorMessage(new Error('test error'))).toBe('test error');
  });

  it('returns string errors as-is', () => {
    expect(getErrorMessage('string error')).toBe('string error');
  });

  it('extracts message property from objects', () => {
    expect(getErrorMessage({ message: 'object error' })).toBe('object error');
  });

  it('returns fallback for null', () => {
    expect(getErrorMessage(null)).toBe('An unexpected error occurred');
  });

  it('returns fallback for undefined', () => {
    expect(getErrorMessage(undefined)).toBe('An unexpected error occurred');
  });

  it('returns fallback for numbers', () => {
    expect(getErrorMessage(42)).toBe('An unexpected error occurred');
  });

  it('returns fallback for objects without message', () => {
    expect(getErrorMessage({ code: 500 })).toBe('An unexpected error occurred');
  });

  it('uses custom fallback message', () => {
    expect(getErrorMessage(null, 'Custom fallback')).toBe('Custom fallback');
  });

  it('handles message property with non-string value', () => {
    expect(getErrorMessage({ message: 123 })).toBe('123');
  });
});

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

describe('handleError', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('logs and returns error message', () => {
    const result = handleError('TestContext', new Error('handled error'));
    expect(result).toBe('handled error');
  });

  it('uses custom fallback message', () => {
    const result = handleError('TestContext', null, 'Custom message');
    expect(result).toBe('Custom message');
  });

  it('returns default fallback for unknown errors', () => {
    const result = handleError('TestContext', { unknown: true });
    expect(result).toBe('An unexpected error occurred');
  });
});
