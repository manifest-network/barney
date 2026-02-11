import { describe, it, expect } from 'vitest';
import { HELP_TEXT } from './helpText';

describe('HELP_TEXT', () => {
  it('is a non-empty string', () => {
    expect(typeof HELP_TEXT).toBe('string');
    expect(HELP_TEXT.length).toBeGreaterThan(0);
  });

  it('contains key sections', () => {
    expect(HELP_TEXT).toContain('Commands');
    expect(HELP_TEXT).toContain('/help');
    expect(HELP_TEXT).toContain('Example prompts');
    expect(HELP_TEXT).toContain('Keyboard shortcuts');
    expect(HELP_TEXT).toContain('Resource tiers');
  });

  it('documents what the assistant can do', () => {
    expect(HELP_TEXT).toContain('Deploy');
    expect(HELP_TEXT).toContain('Stop');
    expect(HELP_TEXT).toContain('credits');
    expect(HELP_TEXT).toContain('logs');
  });
});
