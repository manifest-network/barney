import { describe, it, expect } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('returns a single class', () => {
    expect(cn('foo')).toBe('foo');
  });

  it('joins multiple classes', () => {
    expect(cn('foo', 'bar', 'baz')).toBe('foo bar baz');
  });

  it('filters out false', () => {
    expect(cn('foo', false, 'bar')).toBe('foo bar');
  });

  it('filters out null', () => {
    expect(cn('foo', null, 'bar')).toBe('foo bar');
  });

  it('filters out undefined', () => {
    expect(cn('foo', undefined, 'bar')).toBe('foo bar');
  });

  it('filters out empty strings', () => {
    expect(cn('foo', '', 'bar')).toBe('foo bar');
  });

  it('handles mixed truthy and falsy inputs', () => {
    expect(cn('a', false, 'b', null, undefined, 'c', '')).toBe('a b c');
  });

  it('returns empty string when called with no arguments', () => {
    expect(cn()).toBe('');
  });

  it('returns empty string when all arguments are falsy', () => {
    expect(cn(false, null, undefined, '')).toBe('');
  });
});
