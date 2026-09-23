import { describe, expect, it, vi } from 'vitest';
import { logPreviewTail } from './deployDiagnostic';

describe('bounded log-tail noise removal', () => {
  it.each([' ', '\u0000\u0085\u202e\u{e0001}'])('finds the last visible line before a large noise suffix (%j)', (noise) => {
    const raw = `${'startup '.repeat(20)}\npanic: visible ending 💥${noise.repeat(250_000)}`;
    const arrays = vi.spyOn(Array, 'from');
    try {
      const result = logPreviewTail(raw, 64);
      expect(result).toContain('panic: visible ending 💥');
      expect([...result].length).toBeLessThanOrEqual(64);
      expect(result.replace(/\n/g, '')).not.toMatch(/[\p{Cf}\p{Cc}]/u);
      expect(new TextDecoder().decode(new TextEncoder().encode(result))).toBe(result);
      const inputs = arrays.mock.calls.map(([input]) => input).filter((input): input is string => typeof input === 'string');
      expect(inputs.every((input) => input.length <= 128)).toBe(true);
    } finally { arrays.mockRestore(); }
  });

  it('stops at a visible ending without searching back through a preceding noise run', () => {
    const text = logPreviewTail(`${' '.repeat(2_000_000)}panic`, 64);
    expect(text).toBe('…panic');
    expect(logPreviewTail('\u202e'.repeat(250_000), 64)).toBe('');
  });
});
