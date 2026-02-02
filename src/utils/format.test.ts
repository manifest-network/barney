import { describe, it, expect } from 'vitest';
import {
  toBaseUnits,
  fromBaseUnits,
  parseBaseUnits,
  formatAmount,
  formatDate,
  formatRelativeTime,
  formatFileSize,
  formatDuration,
  isValidUUID,
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

describe('formatAmount', () => {
  it('formats MFX amounts correctly', () => {
    expect(formatAmount('1000000', 'umfx')).toBe('1 MFX');
    expect(formatAmount('1500000', 'umfx')).toBe('1.5 MFX');
  });

  it('formats PWR amounts correctly', () => {
    expect(formatAmount('1000000', 'upwr')).toBe('1 PWR');
  });

  it('handles zero amounts', () => {
    expect(formatAmount('0', 'umfx')).toBe('0 MFX');
  });

  it('handles invalid amounts', () => {
    expect(formatAmount('invalid', 'umfx')).toBe('0 MFX');
  });

  it('respects maxDecimals parameter', () => {
    expect(formatAmount('1234567', 'umfx', 2)).toBe('1.23 MFX');
  });

  it('handles unknown denominations', () => {
    expect(formatAmount('1000000', 'unknown')).toBe('1 unknown');
  });
});

describe('formatDate', () => {
  it('formats valid date strings', () => {
    const result = formatDate('2024-01-15T10:30:00Z');
    expect(result).not.toBe('-');
    expect(typeof result).toBe('string');
  });

  it('returns "-" for empty string', () => {
    expect(formatDate('')).toBe('-');
  });

  it('returns "-" for undefined', () => {
    expect(formatDate(undefined)).toBe('-');
  });

  it('returns "-" for Go zero time', () => {
    expect(formatDate('0001-01-01T00:00:00Z')).toBe('-');
  });

  it('returns "-" for invalid date', () => {
    expect(formatDate('not-a-date')).toBe('-');
  });

  it('supports date-only format', () => {
    const result = formatDate('2024-01-15T10:30:00Z', 'date');
    expect(result).not.toBe('-');
    // Should not include time
    expect(result.includes(':')).toBe(false);
  });
});

describe('formatRelativeTime', () => {
  it('returns "-" for empty string', () => {
    expect(formatRelativeTime('')).toBe('-');
  });

  it('returns "-" for undefined', () => {
    expect(formatRelativeTime(undefined)).toBe('-');
  });

  it('returns "-" for Go zero time', () => {
    expect(formatRelativeTime('0001-01-01T00:00:00Z')).toBe('-');
  });

  it('returns "just now" for very recent dates', () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe('just now');
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

describe('formatDuration', () => {
  it('formats seconds', () => {
    expect(formatDuration('30')).toBe('30s');
  });

  it('formats minutes', () => {
    expect(formatDuration('120')).toBe('2m');
  });

  it('formats hours', () => {
    expect(formatDuration('3600')).toBe('1h');
    expect(formatDuration('5400')).toBe('1h 30m');
  });

  it('formats days', () => {
    expect(formatDuration('86400')).toBe('1d');
    expect(formatDuration('90000')).toBe('1d 1h');
  });

  it('handles Go duration format with "s" suffix', () => {
    expect(formatDuration('3600s')).toBe('1h');
  });

  it('handles nanoseconds', () => {
    // 1 hour in nanoseconds
    expect(formatDuration('3600000000000')).toBe('1h');
  });

  it('returns "-" for undefined', () => {
    expect(formatDuration(undefined)).toBe('-');
  });

  it('returns "0s" for zero', () => {
    expect(formatDuration('0')).toBe('0s');
  });
});

describe('isValidUUID', () => {
  it('validates correct UUIDs', () => {
    expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidUUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
  });

  it('rejects invalid UUIDs', () => {
    expect(isValidUUID('')).toBe(false);
    expect(isValidUUID('not-a-uuid')).toBe(false);
    expect(isValidUUID('550e8400-e29b-41d4-a716')).toBe(false); // too short
    expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000-extra')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(isValidUUID('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
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
