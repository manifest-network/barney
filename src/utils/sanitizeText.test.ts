import { describe, it, expect } from 'vitest';
import {
  sanitizeForDisplay,
  CHECK_NAME_CHARS,
  CHECK_MESSAGE_CHARS,
  MAX_HEALTH_ERROR_CHARS,
  HEALTH_STATUS_CHARS,
  MAX_REPORTED_CHECKS,
} from './sanitizeText';

/**
 * Untrusted text is written with explicit escapes throughout: a literal U+202E or
 * U+200B in the source would be invisible to a reviewer and could be stripped by
 * a well-meaning editor, silently defanging the test.
 */
const RLO = '\u202E'; // RIGHT-TO-LEFT OVERRIDE (Cf)
const ZWSP = '\u200B'; // ZERO WIDTH SPACE (Cf)
const BOM = '\uFEFF'; // ZERO WIDTH NO-BREAK SPACE (Cf)
const LS = '\u2028'; // LINE SEPARATOR (Zl)
const PS = '\u2029'; // PARAGRAPH SEPARATOR (Zp)
const REPLACEMENT = '\uFFFD';

/**
 * Under the `u` flag a well-formed pair is one code point outside this range, so
 * this matches ONLY an unpaired surrogate — what a code-unit slice leaves behind.
 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** Round-trips through UTF-8; a lone surrogate comes back as U+FFFD. */
function utf8RoundTrip(s: string): string {
  return new TextDecoder().decode(new TextEncoder().encode(s));
}

describe('sanitizeForDisplay', () => {
  describe('stripping control and format characters', () => {
    it('strips a bidi override smuggled into a provider verdict', () => {
      // U+202E would reorder everything after it when rendered, letting a provider
      // forge prose around its own status string.
      const result = sanitizeForDisplay(`deg${RLO}raded`, 32);
      expect(result).not.toContain(RLO);
      expect(Array.from(result).length).toBeLessThanOrEqual(33); // 32 + ellipsis
      expect(result).toBe('deg raded');
    });

    it('strips NUL, newlines and line/paragraph separators', () => {
      expect(sanitizeForDisplay('a\u0000b')).toBe('a b');
      expect(sanitizeForDisplay('chain failed\r\nProvider: trusted')).toBe(
        'chain failed Provider: trusted'
      );
      expect(sanitizeForDisplay(`a${LS}b${PS}c`)).toBe('a b c');
    });

    it('strips zero-width format characters', () => {
      expect(sanitizeForDisplay(`he${ZWSP}al${BOM}thy`)).toBe('he al thy');
    });

    it('collapses whitespace runs and trims', () => {
      expect(sanitizeForDisplay('a  b')).toBe('a b');
      expect(sanitizeForDisplay('  padded\t\tvalue  ')).toBe('padded value');
    });

    it('normalizes to NFC', () => {
      // 'e' + U+0301 COMBINING ACUTE composes to the single code point U+00E9.
      expect(sanitizeForDisplay('e\u0301')).toBe('\u00E9');
      expect(Array.from(sanitizeForDisplay('e\u0301')).length).toBe(1);
    });
  });

  describe('capping', () => {
    it('caps a 5000-char message at maxLength + 1 code points', () => {
      const result = sanitizeForDisplay('x'.repeat(5000), 1024);
      expect(result.length).toBeLessThanOrEqual(1025);
      expect(result.endsWith('…')).toBe(true);
    });

    it('defaults maxLength to 64', () => {
      expect(Array.from(sanitizeForDisplay('y'.repeat(200))).length).toBe(65);
    });

    it('leaves a value at exactly maxLength untruncated', () => {
      expect(sanitizeForDisplay('z'.repeat(10), 10)).toBe('z'.repeat(10));
      expect(sanitizeForDisplay('z'.repeat(11), 10)).toBe(`${'z'.repeat(10)}…`);
    });

    it('caps by code point, never bisecting a surrogate pair', () => {
      // Each emoji is one astral code point = two UTF-16 code units, so a
      // String.prototype.slice(0, 5) cap would cut mid-pair. Assert on the LONE
      // SURROGATE that leaves in the raw result — U+FFFD only appears one step
      // later, at encode/render time, so `not.toContain(REPLACEMENT)` on the raw
      // string would pass for the sliced output too.
      const result = sanitizeForDisplay('\u{1F600}'.repeat(10), 5);
      expect(Array.from(result)).toHaveLength(6); // 5 emoji + ellipsis
      expect(result).toBe(`${'\u{1F600}'.repeat(5)}…`);
      expect(LONE_SURROGATE.test(result)).toBe(false);
      // …and the encode step is where a bisected pair would surface as U+FFFD.
      expect(utf8RoundTrip(result)).toBe(result);
      expect(utf8RoundTrip(result)).not.toContain(REPLACEMENT);
    });

    it('returns the value unchanged for a negative or non-integer cap', () => {
      expect(sanitizeForDisplay('abcdef', -1)).toBe('abcdef');
      expect(sanitizeForDisplay('abcdef', 2.5)).toBe('abcdef');
    });
  });

  describe('placeholder', () => {
    it('returns the placeholder for an empty string', () => {
      expect(sanitizeForDisplay('')).toBe('(hidden)');
    });

    it('returns the placeholder when nothing survives stripping', () => {
      expect(sanitizeForDisplay('   ')).toBe('(hidden)');
      expect(sanitizeForDisplay(` ${ZWSP}`)).toBe('(hidden)');
    });

    it('honours a custom placeholder', () => {
      expect(sanitizeForDisplay('', 64, '(unnamed SKU)')).toBe('(unnamed SKU)');
    });
  });

  describe('non-string input', () => {
    it('coerces nullish input to the placeholder', () => {
      expect(sanitizeForDisplay(undefined)).toBe('(hidden)');
      expect(sanitizeForDisplay(null)).toBe('(hidden)');
    });

    it('coerces other primitives with String()', () => {
      expect(sanitizeForDisplay(42)).toBe('42');
      expect(sanitizeForDisplay(false)).toBe('false');
    });
  });
});

describe('health-text caps', () => {
  // Pinned to mono v0.21.0 packages/fred/src/tools/browseCatalog.ts so barney's
  // browse_catalog rows stay byte-comparable with the SDK's own summary.
  it('matches the SDK values', () => {
    expect(CHECK_NAME_CHARS).toBe(64);
    expect(CHECK_MESSAGE_CHARS).toBe(120);
    expect(MAX_HEALTH_ERROR_CHARS).toBe(1024);
    expect(HEALTH_STATUS_CHARS).toBe(32);
    expect(MAX_REPORTED_CHECKS).toBe(5);
  });
});
