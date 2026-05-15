import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateCustomDomainFormat,
  isApex,
  isReservedSuffix,
  validateAll,
} from './customDomainValidation';
import * as billingParams from '../api/billingParams';

vi.mock('../api/billingParams', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/billingParams')>();
  return { ...actual, getReservedDomainSuffixes: vi.fn() };
});

describe('validateCustomDomainFormat', () => {
  it('accepts standard FQDNs', () => {
    expect(validateCustomDomainFormat('app.example.com')).toBeNull();
    expect(validateCustomDomainFormat('a.b.c.example.org')).toBeNull();
  });

  it('strips trailing dot', () => {
    expect(validateCustomDomainFormat('app.example.com.')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(validateCustomDomainFormat('')?.toLowerCase()).toContain('empty');
  });

  it('rejects single label without TLD', () => {
    expect(validateCustomDomainFormat('localhost')).toContain('at least one dot');
  });

  it('rejects bare protocol injection', () => {
    expect(validateCustomDomainFormat('http://app.example.com')).not.toBeNull();
  });

  it('rejects path injection', () => {
    expect(validateCustomDomainFormat('app.example.com/foo')).not.toBeNull();
  });

  it('rejects ports', () => {
    expect(validateCustomDomainFormat('app.example.com:443')).not.toBeNull();
  });

  it('rejects spaces', () => {
    expect(validateCustomDomainFormat('app .example.com')).not.toBeNull();
  });

  it('rejects IPv4 literals', () => {
    expect(validateCustomDomainFormat('192.168.1.1')).toMatch(/IP address/i);
    expect(validateCustomDomainFormat('1.2.3.4')).toMatch(/IP address/i);
    expect(validateCustomDomainFormat('10.0.0.1')).toMatch(/IP address/i);
  });

  it('rejects IPv6 literals', () => {
    expect(validateCustomDomainFormat('2606:4700::1111')).not.toBeNull();
  });

  it('does not confuse domains that look like IPs (numeric labels)', () => {
    // 4 numeric-only labels that fit in 0-255 — would parse as IP.
    expect(validateCustomDomainFormat('192.168.1.1')).toMatch(/IP address/i);
    // Domains with numeric subdomains under a real TLD are fine.
    expect(validateCustomDomainFormat('1.example.com')).toBeNull();
    expect(validateCustomDomainFormat('1.2.example.com')).toBeNull();
  });
});

describe('isApex', () => {
  it('treats 2-label hostname as apex', () => {
    expect(isApex('example.com')).toBe(true);
  });

  it('treats subdomain as non-apex', () => {
    expect(isApex('app.example.com')).toBe(false);
    expect(isApex('a.b.example.com')).toBe(false);
  });

  it('strips trailing dot', () => {
    expect(isApex('example.com.')).toBe(true);
  });

  it('returns false for single-label hostnames (no TLD)', () => {
    expect(isApex('localhost')).toBe(false);
  });

  it('treats apex of multi-label ICANN public suffix as apex', () => {
    expect(isApex('bbc.co.uk')).toBe(true);
    expect(isApex('example.co.uk')).toBe(true);
    expect(isApex('foo.com.br')).toBe(true);
  });

  it('treats subdomain on multi-label ICANN public suffix as non-apex', () => {
    expect(isApex('app.bbc.co.uk')).toBe(false);
    expect(isApex('a.b.example.co.uk')).toBe(false);
  });

  it('treats apex of multi-label PRIVATE public suffix as apex', () => {
    // Private PSL entries: github.io, netlify.app, vercel.app, etc.
    expect(isApex('mysite.github.io')).toBe(true);
    expect(isApex('foo.netlify.app')).toBe(true);
    expect(isApex('bar.vercel.app')).toBe(true);
  });

  it('treats subdomain on PRIVATE public suffix as non-apex', () => {
    expect(isApex('blog.mysite.github.io')).toBe(false);
    expect(isApex('api.foo.netlify.app')).toBe(false);
  });

  it('returns false for IP addresses', () => {
    expect(isApex('192.168.1.1')).toBe(false);
    expect(isApex('10.0.0.1')).toBe(false);
  });

  it('returns true for a bare public suffix (no registerable domain)', () => {
    // Conservative: warning rather than silent accept. The reserved-suffix
    // and format checks earlier in the pipeline catch most of these anyway.
    expect(isApex('co.uk')).toBe(true);
  });
});

describe('isReservedSuffix', () => {
  const SUFFIXES = ['.barney0.manifest0.net', '.foo.test'];

  it('returns false when fqdn is outside any reserved zone', () => {
    expect(isReservedSuffix('app.example.com', SUFFIXES)).toBe(false);
  });

  it('returns true on label-boundary suffix match', () => {
    expect(isReservedSuffix('myapp.barney0.manifest0.net', SUFFIXES)).toBe(true);
  });

  it('returns true on apex form (no leading subdomain)', () => {
    expect(isReservedSuffix('barney0.manifest0.net', SUFFIXES)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isReservedSuffix('Foo.Barney0.Manifest0.Net', SUFFIXES)).toBe(true);
  });

  it('does not partial-match across labels', () => {
    // "evil-barney0.manifest0.net" should NOT match ".barney0.manifest0.net"
    expect(isReservedSuffix('evilbarney0.manifest0.net', SUFFIXES)).toBe(false);
  });

  it('tolerates suffix entries that omit the leading dot', () => {
    expect(isReservedSuffix('x.manifest0.net', ['manifest0.net'])).toBe(true);
    expect(isReservedSuffix('manifest0.net', ['manifest0.net'])).toBe(true);
  });

  it('returns false when suffix list is empty', () => {
    expect(isReservedSuffix('anything.com', [])).toBe(false);
  });
});

describe('validateAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(billingParams.getReservedDomainSuffixes).mockResolvedValue([
      '.barney0.manifest0.net',
    ]);
  });

  it('returns format error on invalid hostname', async () => {
    const r = await validateAll('not a domain');
    expect(r.error).toBeTruthy();
  });

  it('returns reserved-zone error on suffix match', async () => {
    const r = await validateAll('myapp.barney0.manifest0.net');
    expect(r.error).toMatch(/reserved/i);
  });

  it('returns apex warning for 2-label valid domain', async () => {
    const r = await validateAll('example.com');
    expect(r.error).toBeUndefined();
    expect(r.warning).toMatch(/apex/i);
  });

  it('returns apex warning for apex on multi-label public suffix (.co.uk)', async () => {
    const r = await validateAll('bbc.co.uk');
    expect(r.error).toBeUndefined();
    expect(r.warning).toMatch(/apex/i);
  });

  it('returns apex warning for apex on private public suffix (.github.io)', async () => {
    const r = await validateAll('mysite.github.io');
    expect(r.error).toBeUndefined();
    expect(r.warning).toMatch(/apex/i);
  });

  it('returns no error/warning for valid subdomain', async () => {
    const r = await validateAll('app.example.com');
    expect(r).toEqual({});
  });

  it('does not block when chain Params fetch fails', async () => {
    vi.mocked(billingParams.getReservedDomainSuffixes).mockRejectedValue(new Error('chain down'));
    const r = await validateAll('app.example.com');
    expect(r.error).toBeUndefined();
  });
});
