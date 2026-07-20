import { describe, it, expect } from 'vitest';
import {
  parseHttpUrl,
  isUrlSsrfSafe,
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

  it('allows the IPv6 loopback [::1] in DEV (bracket-stripped lookup)', () => {
    // WHATWG URL hands back IPv6 hostnames bracketed (`[::1]`), which never
    // matched the stored `'::1'` before the bracket strip.
    expect(isUrlSsrfSafe(new URL('http://[::1]:8080'))).toBe(true);
  });

  it('blocks a non-loopback IPv6 address', () => {
    expect(isUrlSsrfSafe(new URL('http://[fc00::1]'))).toBe(false);
  });
});
