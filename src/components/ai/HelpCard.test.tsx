import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { ResolvedSkuTier } from '../../api/skuTiers';

const retrySkuTiers = vi.fn();
let skuTiers: {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  tiers: ResolvedSkuTier[];
  denomSymbol: string;
  error: string | null;
} = {
  phase: 'idle',
  tiers: [],
  denomSymbol: '',
  error: null,
};

vi.mock('../../hooks/useAI', () => ({
  useAI: () => ({ skuTiers, retrySkuTiers }),
}));

import { HelpCard } from './HelpCard';

const READY_TIER: ResolvedSkuTier = {
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

let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root.render(createElement(HelpCard));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  flushSync(() => {
    root?.unmount();
  });
  container?.remove();
});

describe('HelpCard', () => {
  it('renders tier rows when ready', () => {
    skuTiers = { phase: 'ready', tiers: [READY_TIER], denomSymbol: 'PWR', error: null };
    render();
    expect(container.textContent).toContain('docker-micro');
    expect(container.textContent).toContain('512 MB');
    expect(container.textContent).toContain('0.0360 PWR/hr');
  });

  it('shows loading message when loading', () => {
    skuTiers = { phase: 'loading', tiers: [], denomSymbol: '', error: null };
    render();
    expect(container.textContent).toMatch(/loading/i);
  });

  it('shows loading message when idle', () => {
    skuTiers = { phase: 'idle', tiers: [], denomSymbol: '', error: null };
    render();
    expect(container.textContent).toMatch(/loading/i);
  });

  it('shows error message and Retry button when errored', () => {
    skuTiers = { phase: 'error', tiers: [], denomSymbol: '', error: 'chain down' };
    render();
    expect(container.textContent).toMatch(/chain down|catalog unavailable/i);
    const retryButton = container.querySelector('button');
    expect(retryButton).not.toBeNull();
    expect(retryButton!.textContent?.toLowerCase()).toContain('retry');
  });

  it('Retry button calls retrySkuTiers', () => {
    skuTiers = { phase: 'error', tiers: [], denomSymbol: '', error: 'oops' };
    render();
    const retryButton = container.querySelector('button')!;
    flushSync(() => {
      retryButton.click();
    });
    expect(retrySkuTiers).toHaveBeenCalled();
  });
});
