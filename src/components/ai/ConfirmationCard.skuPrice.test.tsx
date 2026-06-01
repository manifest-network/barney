import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { ResolvedSkuTier } from '../../api/skuTiers';

let skuTiers: {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  tiers: ResolvedSkuTier[];
  denomSymbol: string;
  error: string | null;
} = { phase: 'idle', tiers: [], denomSymbol: '', error: null };

vi.mock('../../hooks/useAI', () => ({
  useAI: () => ({ skuTiers }),
}));

import { ConfirmationCard } from './ConfirmationCard';
import type { PendingAction } from '../../ai/toolExecutor';

const SAMPLE_TIER: ResolvedSkuTier = {
  skuName: 'docker-micro',
  skuUuid: 'a',
  providerUuid: 'p',
  cores: 0.5,
  ramMB: 512,
  diskGB: 1,
  pricePerHour: 0.036,
  denomSymbol: 'PWR',
  unit: 1,
};

const ACTION: PendingAction = {
  id: '1',
  toolName: 'deploy_app',
  description: 'Deploy redis on docker-micro',
  args: { app_name: 'redis', size: 'docker-micro' },
};

let container: HTMLDivElement;
let root: Root;

function render(action: PendingAction = ACTION) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root.render(
      createElement(ConfirmationCard, {
        action,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
  });
}

function makeTier(overrides: Partial<ResolvedSkuTier> = {}): ResolvedSkuTier {
  return {
    skuName: 'docker-micro',
    skuUuid: 'u',
    providerUuid: 'p',
    cores: 0.5,
    ramMB: 512,
    diskGB: 1,
    pricePerHour: 0.036,
    denomSymbol: 'PWR',
    unit: 1,
    ...overrides,
  };
}

function makeAction(args: Record<string, unknown>): PendingAction {
  return { ...ACTION, args: { ...ACTION.args, ...args } };
}

afterEach(() => {
  flushSync(() => {
    root?.unmount();
  });
  container?.remove();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConfirmationCard SKU price line', () => {
  it('renders price AND specs for the resolved tier on ready', () => {
    skuTiers = { phase: 'ready', tiers: [SAMPLE_TIER], denomSymbol: 'PWR', error: null };
    render();
    expect(container.textContent).toContain('0.0360 PWR/hr');
    expect(container.textContent).toContain('Estimated price');
    expect(container.textContent).toContain('0.5 vCPU · 512 MB RAM · 1 GB disk');
  });

  it('renders skeleton when loading', () => {
    skuTiers = { phase: 'loading', tiers: [], denomSymbol: '', error: null };
    render();
    const skeleton = container.querySelector('[data-testid="sku-price-skeleton"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton!.textContent).toMatch(/loading/i);
  });

  it('renders unavailable warning when errored', () => {
    skuTiers = { phase: 'error', tiers: [], denomSymbol: '', error: 'chain down' };
    render();
    expect(container.textContent).toContain('Price unavailable');
    expect(container.textContent).toMatch(/chain down|tier catalog/i);
  });

  it('keeps Confirm enabled even when tiers are not ready (gating removed)', () => {
    // The executor falls back to the cheapest tier, or returns an inline
    // "Tier catalog unavailable" error on an empty catalog. The button is no
    // longer disabled on tier phase.
    skuTiers = { phase: 'loading', tiers: [], denomSymbol: '', error: null };
    render();
    const buttons = container.querySelectorAll('button');
    const confirm = Array.from(buttons).find((b) => b.textContent?.includes('Confirm'));
    expect(confirm).not.toBeUndefined();
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  it('enables Confirm button when tiers are ready', () => {
    skuTiers = { phase: 'ready', tiers: [SAMPLE_TIER], denomSymbol: 'PWR', error: null };
    render();
    const buttons = container.querySelectorAll('button');
    const confirm = Array.from(buttons).find((b) => b.textContent?.includes('Confirm'));
    expect(confirm).not.toBeUndefined();
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  // Pass-5 fix: the selectedTier lookup previously did only 2 of resolveSizeName's
  // 3 fallbacks (canonical + docker- prefix), and didn't lowercase the catalog
  // side. So model-emitted shorthand like 'large' against a non-docker-prefixed
  // SKU, or 'small' against a mixed-case catalog, would fall through to the
  // "no tier resolved → skeleton/unavailable" branch even though the executor
  // would happily accept the deploy. Confirm wasn't gated on selectedTier
  // existing, so users could approve with incomplete price info.

  it('resolves suffix-only size against a non-docker-prefixed SKU (e.g. "large" → "gpu-large")', () => {
    const gpu = makeTier({ skuName: 'gpu-large', pricePerHour: 0.42 });
    skuTiers = { phase: 'ready', tiers: [gpu], denomSymbol: 'PWR', error: null };
    render(makeAction({ size: 'large' }));
    expect(container.textContent).toContain('0.4200 PWR/hr');
    expect(container.textContent).toContain('Estimated price');
    expect(container.textContent).not.toContain('Price unavailable');
    expect(container.querySelector('[data-testid="sku-price-skeleton"]')).toBeNull();
  });

  it('resolves docker- prefix size against a mixed-case catalog SKU (e.g. "small" → "Docker-Small")', () => {
    const mixedSmall = makeTier({ skuName: 'Docker-Small', pricePerHour: 0.1 });
    skuTiers = { phase: 'ready', tiers: [mixedSmall], denomSymbol: 'PWR', error: null };
    render(makeAction({ size: 'small' }));
    expect(container.textContent).toContain('0.1000 PWR/hr');
    expect(container.textContent).toContain('Estimated price');
    expect(container.textContent).not.toContain('Price unavailable');
  });

  it('resolves canonical match (regression — pre-existing behavior preserved)', () => {
    skuTiers = { phase: 'ready', tiers: [SAMPLE_TIER], denomSymbol: 'PWR', error: null };
    render(makeAction({ size: 'docker-micro' }));
    expect(container.textContent).toContain('0.0360 PWR/hr');
  });

  it('resolves docker- prefix backward-compat shorthand (regression — pre-existing behavior preserved)', () => {
    skuTiers = { phase: 'ready', tiers: [SAMPLE_TIER], denomSymbol: 'PWR', error: null };
    render(makeAction({ size: 'micro' }));
    expect(container.textContent).toContain('0.0360 PWR/hr');
  });

  // Size-substitution note (POLA): only when a size was explicitly requested
  // but isn't offered on this network. An omitted/resolved size shows no note.
  it('names the substitution when an explicitly-requested size is unavailable', () => {
    skuTiers = { phase: 'ready', tiers: [SAMPLE_TIER], denomSymbol: 'PWR', error: null };
    render(makeAction({ size: 'xxlarge' }));
    expect(container.textContent).toContain('0.0360 PWR/hr'); // cheapest fallback
    expect(container.textContent).toContain('Requested size');
    expect(container.textContent).toContain('xxlarge');
    expect(container.textContent).toContain('docker-micro');
    expect(container.textContent).toContain('cheapest available');
  });

  it('shows NO substitution note when size resolves exactly', () => {
    skuTiers = { phase: 'ready', tiers: [SAMPLE_TIER], denomSymbol: 'PWR', error: null };
    render(makeAction({ size: 'docker-micro' }));
    expect(container.textContent).not.toContain('isn’t offered on this network');
  });

  it('shows NO substitution note when size is omitted (cheapest default is unsurprising)', () => {
    skuTiers = { phase: 'ready', tiers: [SAMPLE_TIER], denomSymbol: 'PWR', error: null };
    const { size: _omit, ...rest } = ACTION.args as Record<string, unknown>;
    render({ ...ACTION, args: rest });
    expect(container.textContent).toContain('0.0360 PWR/hr');
    expect(container.textContent).not.toContain('isn’t offered on this network');
  });
});
