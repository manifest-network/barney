import { describe, it, expect } from 'vitest';
import { buildHelpText } from './helpText';
import type { ResolvedSkuTier } from '../api/skuTiers';

const SAMPLE_TIERS: ResolvedSkuTier[] = [
  { skuName: 'docker-micro', skuUuid: 'a', providerUuid: 'p', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
  { skuName: 'docker-large', skuUuid: 'b', providerUuid: 'p', cores: 4, ramMB: 4096, diskGB: 20, pricePerHour: 0.5, denomSymbol: 'PWR', unit: 1 },
];

describe('buildHelpText', () => {
  it('returns a non-empty string with key sections', () => {
    const text = buildHelpText(SAMPLE_TIERS);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('Commands');
    expect(text).toContain('/help');
    expect(text).toContain('/clear');
    expect(text).toContain('Example prompts');
    expect(text).toContain('Keyboard shortcuts');
    expect(text).toContain('Resource tiers');
  });

  it('documents what the assistant can do', () => {
    const text = buildHelpText(SAMPLE_TIERS);
    expect(text).toContain('Deploy');
    expect(text).toContain('Stop');
    expect(text).toContain('credits');
    expect(text).toContain('logs');
  });

  it('renders one row per resolved tier (no extras)', () => {
    const text = buildHelpText(SAMPLE_TIERS);
    expect(text).toContain('docker-micro');
    expect(text).toContain('docker-large');
    expect(text).not.toContain('docker-small');
    expect(text).not.toContain('docker-medium');
  });

  it('includes per-tier price formatted as $/hr', () => {
    const text = buildHelpText(SAMPLE_TIERS);
    expect(text).toContain('0.0360 PWR/hr');
    expect(text).toContain('0.5000 PWR/hr');
  });

  it('renders a status row when no tiers', () => {
    const text = buildHelpText([]);
    expect(text).toContain('Resource tiers');
    expect(text).toMatch(/loading|unavailable/i);
  });
});
