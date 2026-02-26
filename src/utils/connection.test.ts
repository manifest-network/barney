import { describe, it, expect } from 'vitest';
import { collectInstanceUrls, isValidFqdn } from './connection';

describe('isValidFqdn', () => {
  it('accepts valid hostnames', () => {
    expect(isValidFqdn('example.com')).toBe(true);
    expect(isValidFqdn('0-abc1234.barney8.manifest0.net')).toBe(true);
    expect(isValidFqdn('web-0-abc1234.barney8.manifest0.net')).toBe(true);
    expect(isValidFqdn('a')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidFqdn('')).toBe(false);
  });

  it('rejects hostnames with path traversal', () => {
    expect(isValidFqdn('evil.com/phish')).toBe(false);
  });

  it('rejects hostnames with protocol injection', () => {
    expect(isValidFqdn('javascript:alert(1)')).toBe(false);
  });

  it('rejects hostnames with spaces', () => {
    expect(isValidFqdn('evil .com')).toBe(false);
  });

  it('rejects labels starting or ending with hyphen', () => {
    expect(isValidFqdn('-bad.com')).toBe(false);
    expect(isValidFqdn('bad-.com')).toBe(false);
  });

  it('rejects hostnames exceeding 253 characters', () => {
    const long = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`;
    expect(long.length).toBeGreaterThan(253);
    expect(isValidFqdn(long)).toBe(false);
  });

  it('rejects labels exceeding 63 characters', () => {
    expect(isValidFqdn(`${'a'.repeat(64)}.com`)).toBe(false);
  });
});

describe('collectInstanceUrls', () => {
  it('returns empty array for undefined connection', () => {
    expect(collectInstanceUrls(undefined)).toEqual([]);
  });

  it('returns empty array for connection with no instances', () => {
    expect(collectInstanceUrls({})).toEqual([]);
  });

  it('returns empty array for single instance (no need to show extras)', () => {
    expect(collectInstanceUrls({
      instances: [{ fqdn: '0-abc1234.barney8.manifest0.net' }],
    })).toEqual([]);
  });

  it('returns URLs for flat multi-instance lease', () => {
    const result = collectInstanceUrls({
      instances: [
        { fqdn: '0-abc1234.barney8.manifest0.net' },
        { fqdn: '1-def5678.barney8.manifest0.net' },
      ],
    });
    expect(result).toEqual([
      '0-abc1234.barney8.manifest0.net',
      '1-def5678.barney8.manifest0.net',
    ]);
  });

  it('returns URLs for stack multi-instance lease', () => {
    const result = collectInstanceUrls({
      services: {
        web: {
          instances: [
            { fqdn: 'web-0-abc1234.barney8.manifest0.net' },
            { fqdn: 'web-1-def5678.barney8.manifest0.net' },
          ],
        },
      },
    });
    expect(result).toEqual([
      'web-0-abc1234.barney8.manifest0.net',
      'web-1-def5678.barney8.manifest0.net',
    ]);
  });

  it('returns empty array when instances have no fqdn', () => {
    expect(collectInstanceUrls({
      instances: [
        { fqdn: undefined },
        { fqdn: undefined },
      ],
    })).toEqual([]);
  });

  it('skips instances without fqdn in mixed array', () => {
    const result = collectInstanceUrls({
      instances: [
        { fqdn: '0-abc1234.barney8.manifest0.net' },
        {},
        { fqdn: '2-ghi9012.barney8.manifest0.net' },
      ],
    });
    expect(result).toEqual([
      '0-abc1234.barney8.manifest0.net',
      '2-ghi9012.barney8.manifest0.net',
    ]);
  });

  it('deduplicates identical FQDNs', () => {
    expect(collectInstanceUrls({
      instances: [
        { fqdn: '0-abc1234.barney8.manifest0.net' },
        { fqdn: '0-abc1234.barney8.manifest0.net' },
      ],
    })).toEqual([]);
  });

  it('collects from both flat instances and services', () => {
    const result = collectInstanceUrls({
      instances: [
        { fqdn: '0-abc1234.barney8.manifest0.net' },
      ],
      services: {
        web: {
          instances: [
            { fqdn: 'web-0-def5678.barney8.manifest0.net' },
          ],
        },
      },
    });
    expect(result).toEqual([
      '0-abc1234.barney8.manifest0.net',
      'web-0-def5678.barney8.manifest0.net',
    ]);
  });

  it('skips FQDNs that fail hostname validation', () => {
    const result = collectInstanceUrls({
      instances: [
        { fqdn: '0-abc1234.barney8.manifest0.net' },
        { fqdn: 'javascript:alert(1)' },
        { fqdn: '1-def5678.barney8.manifest0.net' },
      ],
    });
    expect(result).toEqual([
      '0-abc1234.barney8.manifest0.net',
      '1-def5678.barney8.manifest0.net',
    ]);
  });

  it('skips FQDNs with path components', () => {
    expect(collectInstanceUrls({
      instances: [
        { fqdn: 'evil.com/phish' },
        { fqdn: 'also-evil.com/steal' },
      ],
    })).toEqual([]);
  });
});
