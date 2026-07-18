import { describe, it, expect } from 'vitest';
import { buildHelpText } from './helpText';
import type { ResolvedSkuTier } from '../api/skuTiers';
import type { SkuTiersState } from '../stores/aiActions/skuTiers';

const SAMPLE_TIERS: ResolvedSkuTier[] = [
  { skuName: 'docker-micro', skuUuid: 'a', providerUuid: 'p', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
  { skuName: 'docker-large', skuUuid: 'b', providerUuid: 'p', cores: 4, ramMB: 4096, diskGB: 20, pricePerHour: 0.5, denomSymbol: 'PWR', unit: 1 },
];

const READY_SLICE: SkuTiersState = {
  phase: 'ready',
  tiers: SAMPLE_TIERS,
  denomSymbol: 'PWR',
  error: null,
};

function sliceWith(overrides: Partial<SkuTiersState> = {}): SkuTiersState {
  return { ...READY_SLICE, ...overrides };
}

describe('buildHelpText', () => {
  it('returns a non-empty string with key sections', () => {
    const text = buildHelpText(READY_SLICE);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('Commands');
    expect(text).toContain('/help');
    expect(text).toContain('/clear');
    expect(text).toContain('Example prompts');
    expect(text).toContain('Keyboard shortcuts');
    expect(text).toContain('Resource tiers');
  });

  it('renders the input-history keyboard shortcut with literal arrow glyphs (not escaped)', () => {
    const text = buildHelpText(READY_SLICE);
    expect(text).toContain('↑ ↓');
    // Regression catcher: the old row emitted the escaped sequence literally.
    expect(text).not.toContain('\\u2191');
  });

  it('documents what the assistant can do', () => {
    const text = buildHelpText(READY_SLICE);
    expect(text).toContain('Deploy');
    expect(text).toContain('Stop');
    expect(text).toContain('credits');
    expect(text).toContain('logs');
  });

  it('renders one row per resolved tier (no extras)', () => {
    const text = buildHelpText(READY_SLICE);
    expect(text).toContain('docker-micro');
    expect(text).toContain('docker-large');
    expect(text).not.toContain('docker-small');
    expect(text).not.toContain('docker-medium');
  });

  it('includes per-tier price formatted as $/hr', () => {
    const text = buildHelpText(READY_SLICE);
    expect(text).toContain('0.0360 PWR/hr');
    expect(text).toContain('0.5000 PWR/hr');
  });

  // -------------------------------------------------------------------------
  // Phase-distinct status rows (pass 14)
  // -------------------------------------------------------------------------
  describe('phase-distinct status rows (pass 14)', () => {
    it('renders the error-state row with the underlying error message when phase === "error"', () => {
      const text = buildHelpText(sliceWith({
        phase: 'error',
        tiers: [],
        error: 'chain unreachable',
      }));
      expect(text).toContain('Resource tiers');
      // Single trailing period after normalize; full italic wrapper preserved.
      expect(text).toContain('_Tier catalog unavailable: chain unreachable._');
      // Should NOT also render the old loading wording (regression catcher).
      expect(text).not.toContain('Tier catalog loading');
      expect(text).not.toContain('not loaded yet');
    });

    it('renders the error-state row without a double period when slice.error already ends with "." (pass-9 cross-coupling)', () => {
      // The pass-8 short-circuit string ends with `.`; without
      // `normalizeErrorPunctuation` the result would be `..._` (two periods
      // before the closing italic underscore). Pass-9 helper strips the
      // trailing period so we re-append exactly one.
      const text = buildHelpText(sliceWith({
        phase: 'error',
        tiers: [],
        error: 'PUBLIC_SKU_SPECS is empty or invalid — no SKU specs configured.',
      }));
      expect(text).toContain('_Tier catalog unavailable: PUBLIC_SKU_SPECS is empty or invalid — no SKU specs configured._');
      // Belt-and-suspenders: no double period anywhere in the rendered output.
      expect(text).not.toContain('..');
    });

    it('falls back to "unknown error" when phase === "error" but error is null (defensive)', () => {
      const text = buildHelpText(sliceWith({
        phase: 'error',
        tiers: [],
        error: null,
      }));
      expect(text).toContain('_Tier catalog unavailable: unknown error._');
    });

    it('renders the loading-state row when phase === "loading"', () => {
      const text = buildHelpText(sliceWith({
        phase: 'loading',
        tiers: [],
        error: null,
      }));
      expect(text).toContain('_Tier catalog loading — refresh in a moment._');
      expect(text).not.toContain('unavailable');
      expect(text).not.toContain('not loaded yet');
    });

    it('renders the idle-state row when phase === "idle"', () => {
      const text = buildHelpText(sliceWith({
        phase: 'idle',
        tiers: [],
        error: null,
      }));
      expect(text).toContain('_Tier catalog not loaded yet._');
      expect(text).not.toContain('loading');
      expect(text).not.toContain('unavailable');
    });

    it('renders the defensive empty-ready row when phase === "ready" but tiers is empty', () => {
      // Real-world this branch is unreachable — loadSkuTiersFn produces an
      // `error` phase when the chain ∩ env intersection is empty. This test
      // locks in the defensive copy so a future change that lets the slice
      // reach `ready` with zero tiers doesn't accidentally fall through to
      // an empty markdown table.
      const text = buildHelpText(sliceWith({
        phase: 'ready',
        tiers: [],
        error: null,
      }));
      expect(text).toContain('_No tiers configured for this network._');
      expect(text).not.toContain('loading');
      expect(text).not.toContain('unavailable');
      expect(text).not.toContain('not loaded yet');
    });

    it('renders the markdown tier table when phase === "ready" with tiers (happy-path regression catcher)', () => {
      const text = buildHelpText(READY_SLICE);
      expect(text).toContain('| Tier | CPU | Memory | Disk | Price |');
      expect(text).toContain('| docker-micro |');
      // None of the status-row italics should appear when the table renders.
      expect(text).not.toContain('Tier catalog unavailable');
      expect(text).not.toContain('Tier catalog loading');
      expect(text).not.toContain('not loaded yet');
      expect(text).not.toContain('No tiers configured');
    });
  });
});
