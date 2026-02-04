import { describe, it, expect } from 'vitest';
import {
  parseHttpUrl,
  isUrlSsrfSafe,
  isValidImageUrl,
  getSafeImageUrl,
} from './url';

describe('parseHttpUrl', () => {
  it('parses valid http URLs', () => {
    const result = parseHttpUrl('http://example.com');
    expect(result).not.toBeNull();
    expect(result!.protocol).toBe('http:');
    expect(result!.hostname).toBe('example.com');
  });

  it('parses valid https URLs', () => {
    const result = parseHttpUrl('https://example.com/path');
    expect(result).not.toBeNull();
    expect(result!.protocol).toBe('https:');
  });

  it('returns null for non-http protocols', () => {
    expect(parseHttpUrl('ftp://example.com')).toBeNull();
    expect(parseHttpUrl('file:///etc/passwd')).toBeNull();
    expect(parseHttpUrl('javascript:alert(1)')).toBeNull();
  });

  it('returns null for empty or invalid input', () => {
    expect(parseHttpUrl('')).toBeNull();
    expect(parseHttpUrl('not a url')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseHttpUrl(null as unknown as string)).toBeNull();
    expect(parseHttpUrl(undefined as unknown as string)).toBeNull();
    expect(parseHttpUrl(123 as unknown as string)).toBeNull();
  });

  it('preserves path and query', () => {
    const result = parseHttpUrl('https://example.com/api/v1?key=value');
    expect(result).not.toBeNull();
    expect(result!.pathname).toBe('/api/v1');
    expect(result!.search).toBe('?key=value');
  });
});

describe('isUrlSsrfSafe', () => {
  it('allows public URLs', () => {
    const url = new URL('https://example.com');
    expect(isUrlSsrfSafe(url)).toBe(true);
  });

  it('allows public IP addresses', () => {
    const url = new URL('http://8.8.8.8');
    expect(isUrlSsrfSafe(url)).toBe(true);
  });

  it('blocks private IP ranges', () => {
    // 10.x.x.x
    expect(isUrlSsrfSafe(new URL('http://10.0.0.1'))).toBe(false);
    // 192.168.x.x
    expect(isUrlSsrfSafe(new URL('http://192.168.1.1'))).toBe(false);
    // 172.16.x.x
    expect(isUrlSsrfSafe(new URL('http://172.16.0.1'))).toBe(false);
  });

  it('blocks non-standard loopback addresses', () => {
    // 127.0.0.2 is NOT in DEV_ALLOWED_HOSTS
    expect(isUrlSsrfSafe(new URL('http://127.0.0.2'))).toBe(false);
  });
});

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
