import { describe, it, expect } from 'vitest';
import {
  isValidBech32Address,
  isValidManifestAddress,
  truncateAddress,
  MANIFEST_ADDRESS_PREFIX,
} from './address';

describe('isValidBech32Address', () => {
  it('rejects invalid bech32 strings', () => {
    expect(isValidBech32Address('invalid')).toBe(false);
    expect(isValidBech32Address('')).toBe(false);
    expect(isValidBech32Address('manifest1invalid')).toBe(false);
    expect(isValidBech32Address('notanaddress')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidBech32Address(null as unknown as string)).toBe(false);
    expect(isValidBech32Address(undefined as unknown as string)).toBe(false);
    expect(isValidBech32Address(123 as unknown as string)).toBe(false);
  });

  it('rejects bech32 with wrong prefix', () => {
    // Even if format looks right, wrong prefix should fail
    expect(isValidBech32Address('cosmos1wrongprefix', 'manifest')).toBe(false);
  });
});

describe('isValidManifestAddress', () => {
  it('rejects non-Manifest addresses', () => {
    expect(isValidManifestAddress('cosmos1abc')).toBe(false);
    expect(isValidManifestAddress('invalid')).toBe(false);
    expect(isValidManifestAddress('')).toBe(false);
  });

  it('rejects addresses without manifest prefix', () => {
    expect(isValidManifestAddress('notmanifest1abc')).toBe(false);
  });
});

describe('truncateAddress', () => {
  it('truncates long addresses', () => {
    const addr = 'manifest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqn4q5q5';
    const result = truncateAddress(addr);
    expect(result).toContain('manifest1q');
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(addr.length);
  });

  it('returns short addresses unchanged', () => {
    const short = 'manifest1abc';
    expect(truncateAddress(short, 10, 6, 20)).toBe(short);
  });

  it('handles empty string', () => {
    expect(truncateAddress('')).toBe('');
  });

  it('respects custom prefix/suffix lengths', () => {
    const addr = 'manifest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqn4q5q5';
    const result = truncateAddress(addr, 8, 4);
    expect(result.startsWith('manifest')).toBe(true);
    expect(result.endsWith('q5q5')).toBe(true);
  });
});

describe('MANIFEST_ADDRESS_PREFIX', () => {
  it('is set to "manifest"', () => {
    expect(MANIFEST_ADDRESS_PREFIX).toBe('manifest');
  });
});
