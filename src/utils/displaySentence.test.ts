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
    ['provider said "no.":', 'provider said "no."'],
    ['provider said “why?”;', 'provider said “why?”'],
    ['provider replied ("no…"),', 'provider replied ("no…")'],
    ['image pull failed.:', 'image pull failed.'],
    ['image pull failed! ;', 'image pull failed!'],
    ['image pull failed: ;', 'image pull failed.'],
    ['image pull failed , :', 'image pull failed.'],
    ['image pull failed. , :', 'image pull failed.'],
    ['provider said "no.": ;', 'provider said "no."'],
    ['UpdateFailed: :', 'UpdateFailed.'],
    ['provider said "no:"', 'provider said "no:".'],
    [' : ; , ', ''],
    ['  ', ''],
  ])('finishes %j without changing quoted content', (input, expected) => {
    expect(finishDisplaySentence(input)).toBe(expected);
  });

  it('preserves long interior separator runs while removing only the trailing run', () => {
    const separators = ' \t,;\u00a0:\n'.repeat(4096);
    const sentence = `Failed${separators}provider said "no."`;
    expect(finishDisplaySentence(`${sentence}${separators}`)).toBe(sentence);
    expect(finishDisplaySentence(`Failed${separators}again`)).toBe(`Failed${separators}again.`);
    expect(finishDisplaySentence(separators)).toBe('');
  });
});
