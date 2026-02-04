import { describe, it, expect } from 'vitest';
import {
  isValidImageUrl,
  getSafeImageUrl,
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
