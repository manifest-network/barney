import { describe, it, expect } from 'vitest';
import { bigIntReplacer } from './json';

describe('bigIntReplacer', () => {
  it('converts BigInt to string and passes other values through', () => {
    expect(bigIntReplacer('k', 42n)).toBe('42');
    expect(bigIntReplacer('k', 0n)).toBe('0');
    expect(bigIntReplacer('k', 42)).toBe(42);
    expect(bigIntReplacer('k', 'hello')).toBe('hello');
    expect(bigIntReplacer('k', null)).toBe(null);
  });

  it('works with JSON.stringify on nested BigInt data', () => {
    const data = { count: 3n, nested: { total: 86400n }, normal: 'hello' };
    const parsed = JSON.parse(JSON.stringify(data, bigIntReplacer));
    expect(parsed).toEqual({ count: '3', nested: { total: '86400' }, normal: 'hello' });
  });
});
