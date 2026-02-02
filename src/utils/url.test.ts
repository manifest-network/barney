import { describe, it, expect } from 'vitest';
import {
  isValidImageUrl,
  getSafeImageUrl,
  validateApiUrl,
  sanitizeForDisplay,
  safeJsonStringify,
} from './url';

describe('isValidImageUrl', () => {
  it('accepts https URLs', () => {
    expect(isValidImageUrl('https://example.com/image.png')).toBe(true);
  });

  it('accepts http URLs', () => {
    expect(isValidImageUrl('http://example.com/image.png')).toBe(true);
  });

  it('rejects javascript: URLs (XSS prevention)', () => {
    expect(isValidImageUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isValidImageUrl('data:image/png;base64,abc123')).toBe(false);
  });

  it('rejects file: URLs', () => {
    expect(isValidImageUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects ftp: URLs', () => {
    expect(isValidImageUrl('ftp://example.com/file')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isValidImageUrl('')).toBe(false);
  });

  it('rejects null/undefined', () => {
    expect(isValidImageUrl(null as unknown as string)).toBe(false);
    expect(isValidImageUrl(undefined as unknown as string)).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isValidImageUrl('not a url')).toBe(false);
  });
});

describe('getSafeImageUrl', () => {
  it('returns valid URLs unchanged', () => {
    expect(getSafeImageUrl('https://example.com/image.png')).toBe('https://example.com/image.png');
  });

  it('returns undefined for invalid URLs', () => {
    expect(getSafeImageUrl('javascript:alert(1)')).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(getSafeImageUrl(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getSafeImageUrl('')).toBeUndefined();
  });
});

describe('validateApiUrl', () => {
  it('returns URL object for valid https URLs', () => {
    const result = validateApiUrl('https://api.example.com/v1');
    expect(result).toBeInstanceOf(URL);
    expect(result?.protocol).toBe('https:');
  });

  it('returns URL object for valid http URLs', () => {
    const result = validateApiUrl('http://localhost:8080');
    expect(result).toBeInstanceOf(URL);
    expect(result?.protocol).toBe('http:');
  });

  it('returns null for file: URLs', () => {
    expect(validateApiUrl('file:///etc/passwd')).toBeNull();
  });

  it('returns null for javascript: URLs', () => {
    expect(validateApiUrl('javascript:void(0)')).toBeNull();
  });

  it('returns null for data: URLs', () => {
    expect(validateApiUrl('data:text/plain,hello')).toBeNull();
  });

  it('returns null for empty strings', () => {
    expect(validateApiUrl('')).toBeNull();
  });

  it('returns null for invalid URLs', () => {
    expect(validateApiUrl('not-a-valid-url')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(validateApiUrl(null as unknown as string)).toBeNull();
    expect(validateApiUrl(undefined as unknown as string)).toBeNull();
  });
});

describe('sanitizeForDisplay', () => {
  it('escapes < and >', () => {
    expect(sanitizeForDisplay('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes &', () => {
    expect(sanitizeForDisplay('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes double quotes', () => {
    expect(sanitizeForDisplay('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('escapes single quotes', () => {
    expect(sanitizeForDisplay("it's")); // Returns: it&#039;s
    expect(sanitizeForDisplay("it's")).toBe("it&#039;s");
  });

  it('handles complex XSS attempts', () => {
    const malicious = '<script>alert("XSS")</script>';
    const sanitized = sanitizeForDisplay(malicious);
    expect(sanitized).not.toContain('<');
    expect(sanitized).not.toContain('>');
    expect(sanitized).toBe('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeForDisplay('')).toBe('');
  });

  it('returns empty string for null/undefined', () => {
    expect(sanitizeForDisplay(null as unknown as string)).toBe('');
    expect(sanitizeForDisplay(undefined as unknown as string)).toBe('');
  });

  it('leaves safe text unchanged', () => {
    expect(sanitizeForDisplay('Hello World')).toBe('Hello World');
  });
});

describe('safeJsonStringify', () => {
  it('stringifies simple objects', () => {
    expect(safeJsonStringify({ key: 'value' })).toBe('{"key":"value"}');
  });

  it('stringifies arrays', () => {
    expect(safeJsonStringify([1, 2, 3])).toBe('[1,2,3]');
  });

  it('stringifies primitives', () => {
    expect(safeJsonStringify('hello')).toBe('"hello"');
    expect(safeJsonStringify(42)).toBe('42');
    expect(safeJsonStringify(true)).toBe('true');
    expect(safeJsonStringify(null)).toBe('null');
  });

  it('truncates long output with default maxLength', () => {
    const longObject = { data: 'x'.repeat(600) };
    const result = safeJsonStringify(longObject);
    expect(result.length).toBeLessThanOrEqual(503); // 500 + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  it('truncates with custom maxLength', () => {
    const obj = { key: 'value' };
    const result = safeJsonStringify(obj, 10);
    expect(result.length).toBeLessThanOrEqual(13); // 10 + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  it('returns [Object] for circular references', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeJsonStringify(circular)).toBe('[Object]');
  });

  it('returns [Object] for objects with throwing toJSON', () => {
    const throwing = {
      toJSON() {
        throw new Error('Cannot serialize');
      },
    };
    expect(safeJsonStringify(throwing)).toBe('[Object]');
  });

  it('handles undefined', () => {
    expect(safeJsonStringify(undefined)).toBe('[Object]');
  });
});
