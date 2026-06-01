import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { PendingAction } from '../../ai/toolExecutor';

// ConfirmationCard reads `skuTiers` from useAI for the deploy_app price/specs
// row. A fixed `ready` slice with two tiers (cheapest = docker-micro) lets us
// assert price, specs, and the size-substitution note.
const skuTiersState = {
  phase: 'ready' as const,
  tiers: [
    { skuName: 'docker-micro', skuUuid: 's1', providerUuid: 'p1', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
    { skuName: 'docker-large', skuUuid: 's2', providerUuid: 'p1', cores: 4, ramMB: 4096, diskGB: 20, pricePerHour: 0.5, denomSymbol: 'PWR', unit: 1 },
  ],
  denomSymbol: 'PWR',
  error: null,
};

vi.mock('../../hooks/useAI', () => ({ useAI: () => ({ skuTiers: skuTiersState }) }));

import { ConfirmationCard } from './ConfirmationCard';

let container: HTMLDivElement;
let root: Root;

function renderCard(action: PendingAction) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root.render(createElement(ConfirmationCard, { action, onConfirm: vi.fn(), onCancel: vi.fn(), isExecuting: false }));
  });
}

function deployAction(args: Record<string, unknown>): PendingAction {
  return { id: 'a', toolName: 'deploy_app', args: { app_name: 'redis', ...args }, description: 'Deploy?' };
}

function priceRow(): HTMLElement {
  return container.querySelector('[data-testid="sku-price-row"]') as HTMLElement;
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { flushSync(() => { root?.unmount(); }); container?.remove(); });

describe('ConfirmationCard price/specs row', () => {
  it('shows the resolved tier price AND specs for an exact size', () => {
    renderCard(deployAction({ size: 'docker-large' }));
    const txt = priceRow().textContent ?? '';
    expect(txt).toContain('0.5000 PWR/hr');
    expect(txt).toContain('4 vCPU · 4 GB RAM · 20 GB disk');
  });

  it('shows the cheapest tier (price+specs) and NO substitution note when size is omitted', () => {
    renderCard(deployAction({}));
    const txt = priceRow().textContent ?? '';
    expect(txt).toContain('0.0360 PWR/hr');
    expect(txt).toContain('0.5 vCPU · 512 MB RAM · 1 GB disk');
    expect(container.textContent ?? '').not.toContain('isn’t offered on this network');
  });

  it('names the substitution when an explicit size is unavailable', () => {
    renderCard(deployAction({ size: 'xxlarge' }));
    const txt = priceRow().textContent ?? '';
    expect(txt).toContain('0.0360 PWR/hr'); // cheapest
    const all = container.textContent ?? '';
    expect(all).toContain('Requested size');
    expect(all).toContain('xxlarge');
    expect(all).toContain('docker-micro');
    expect(all).toContain('cheapest available');
  });

  it('enables Confirm regardless of phase', () => {
    renderCard(deployAction({ size: 'docker-large' }));
    const confirm = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Confirm')) as HTMLButtonElement;
    expect(confirm).toBeTruthy();
    expect(confirm.disabled).toBe(false);
  });
});
