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
});

describe('isApex', () => {
  it('treats 2-label hostname as apex', () => {
    expect(isApex('example.com')).toBe(true);
  });

  it('treats subdomain as non-apex', () => {
    expect(isApex('app.example.com')).toBe(false);
    expect(isApex('a.b.example.com')).toBe(false);
  });

  it('strips trailing dot before counting', () => {
    expect(isApex('example.com.')).toBe(true);
  });

  it('returns false for single-label hostnames (no TLD)', () => {
    expect(isApex('localhost')).toBe(false);
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
