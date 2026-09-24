import { describe, expect, it } from 'vitest';
import { finishDisplaySentence } from './displaySentence';

describe('finishDisplaySentence', () => {
  it.each([
    ['  image pull failed  ', 'image pull failed.'],
    ['image pull failed:', 'image pull failed.'],
    ['image pull failed;', 'image pull failed.'],
    ['image pull failed,', 'image pull failed.'],
    ['provider said "no."', 'provider said "no."'],
    ['provider said “why?”', 'provider said “why?”'],
    ['provider said ‘no!’', 'provider said ‘no!’'],
    ['provider replied ("no…")', 'provider replied ("no…")'],
    ['provider said "no:"', 'provider said "no:".'],
    ['  ', ''],
  ])('finishes %j without changing quoted content', (input, expected) => {
    expect(finishDisplaySentence(input)).toBe(expected);
  });
});
