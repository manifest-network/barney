import { describe, it, expect } from 'vitest';
import { truncateAddress } from './address';

describe('truncateAddress', () => {
  it('truncates long addresses with default prefix=13 and suffix=4', () => {
    const addr = 'manifest1uqxan5chgq65eaj0f63knnr6u4t0yqhm5ck526e';
    const result = truncateAddress(addr);
    expect(result).toBe('manifest1uqxa...526e');
  });

  it('returns short addresses unchanged', () => {
    const short = 'manifest1abc';
    expect(truncateAddress(short)).toBe(short);
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
