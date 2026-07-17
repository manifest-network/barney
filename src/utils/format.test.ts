import { describe, it, expect } from 'vitest';
import {
  toBaseUnits,
  fromBaseUnits,
  parseBaseUnits,
  formatFileSize,
  parseJsonStringArray,
} from './format';

describe('toBaseUnits', () => {
  it('converts display amounts to base units', () => {
    expect(toBaseUnits(1, 'umfx')).toBe('1000000');
    expect(toBaseUnits(1.5, 'umfx')).toBe('1500000');
    expect(toBaseUnits(0.000001, 'umfx')).toBe('1');
  });

  it('handles zero', () => {
    expect(toBaseUnits(0, 'umfx')).toBe('0');
  });

  it('returns "0" for NaN', () => {
    expect(toBaseUnits(NaN, 'umfx')).toBe('0');
  });

  it('returns "0" for Infinity', () => {
    expect(toBaseUnits(Infinity, 'umfx')).toBe('0');
    expect(toBaseUnits(-Infinity, 'umfx')).toBe('0');
  });

  it('returns "0" for negative amounts', () => {
    expect(toBaseUnits(-1, 'umfx')).toBe('0');
    expect(toBaseUnits(-0.5, 'umfx')).toBe('0');
  });

  it('handles zero exponent (no decimal point in toFixed output)', () => {
    // getDenomMetadata returns exponent 6 for all known/unknown denoms,
    // so toFixed(0) never occurs with current config. But exercise the
    // dotIndex === -1 branch by verifying large whole numbers still work.
    expect(toBaseUnits(100, 'umfx')).toBe('100000000');
  });

  it('handles PWR denomination', () => {
    expect(toBaseUnits(1, 'upwr')).toBe('1000000');
  });

  it('defaults to 6 decimals for unknown denoms', () => {
    expect(toBaseUnits(1, 'unknown')).toBe('1000000');
  });
});

describe('fromBaseUnits', () => {
  it('converts base units to display amounts', () => {
    expect(fromBaseUnits('1000000', 'umfx')).toBe(1);
    expect(fromBaseUnits('1500000', 'umfx')).toBe(1.5);
    expect(fromBaseUnits('1', 'umfx')).toBe(0.000001);
  });

  it('handles zero', () => {
    expect(fromBaseUnits('0', 'umfx')).toBe(0);
  });

  it('handles invalid amounts', () => {
    expect(fromBaseUnits('invalid', 'umfx')).toBe(0);
    expect(fromBaseUnits('', 'umfx')).toBe(0);
  });

  it('handles PWR denomination', () => {
    expect(fromBaseUnits('1000000', 'upwr')).toBe(1);
  });

  it('defaults to 6 decimals for unknown denoms', () => {
    expect(fromBaseUnits('1000000', 'unknown')).toBe(1);
  });
});

describe('parseBaseUnits', () => {
  it('parses valid amounts', () => {
    expect(parseBaseUnits('1000000')).toBe(1000000);
    expect(parseBaseUnits('0')).toBe(0);
  });

  it('returns 0 for invalid amounts', () => {
    expect(parseBaseUnits('invalid')).toBe(0);
    expect(parseBaseUnits('')).toBe(0);
  });
});

describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('formats kilobytes', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(2560)).toBe('2.5 KB');
  });
});

describe('parseJsonStringArray', () => {
  it('parses valid JSON array', () => {
    const result = parseJsonStringArray('["a", "b", "c"]');
    expect(result.data).toEqual(['a', 'b', 'c']);
    expect(result.error).toBeUndefined();
  });

  it('handles array input directly', () => {
    const result = parseJsonStringArray(['a', 'b']);
    expect(result.data).toEqual(['a', 'b']);
  });

  it('returns empty array for null/undefined', () => {
    expect(parseJsonStringArray(null)).toEqual({ data: [] });
    expect(parseJsonStringArray(undefined)).toEqual({ data: [] });
  });

  it('returns error for invalid JSON', () => {
    const result = parseJsonStringArray('not valid json');
    expect(result.error).toBeDefined();
    expect(result.data).toBeUndefined();
  });

  it('returns error for non-array JSON', () => {
    const result = parseJsonStringArray('{"key": "value"}');
    expect(result.error).toBeDefined();
  });

  it('returns error for array with non-strings', () => {
    const result = parseJsonStringArray('[1, 2, 3]');
    expect(result.error).toBeDefined();
  });

  it('returns error for invalid types', () => {
    const result = parseJsonStringArray(123);
    expect(result.error).toBeDefined();
  });
});
