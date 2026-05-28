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

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root.render(
      createElement(ConfirmationCard, {
        action: ACTION,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
  });
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
  it('renders price for the resolved tier on ready', () => {
    skuTiers = { phase: 'ready', tiers: [SAMPLE_TIER], denomSymbol: 'PWR', error: null };
    render();
    expect(container.textContent).toContain('0.0360 PWR/hr');
    expect(container.textContent).toContain('Estimated price');
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

  it('disables Confirm button when tiers are not ready', () => {
    skuTiers = { phase: 'loading', tiers: [], denomSymbol: '', error: null };
    render();
    const buttons = container.querySelectorAll('button');
    const confirm = Array.from(buttons).find((b) => b.textContent?.includes('Confirm'));
    expect(confirm).not.toBeUndefined();
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Confirm button when tiers are ready', () => {
    skuTiers = { phase: 'ready', tiers: [SAMPLE_TIER], denomSymbol: 'PWR', error: null };
    render();
    const buttons = container.querySelectorAll('button');
    const confirm = Array.from(buttons).find((b) => b.textContent?.includes('Confirm'));
    expect(confirm).not.toBeUndefined();
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });
});
