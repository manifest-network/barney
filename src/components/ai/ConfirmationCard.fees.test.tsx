import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { ConfirmationCard } from './ConfirmationCard';
import type { PendingAction } from '../../ai/toolExecutor';

vi.mock('../../config/chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/chain')>()),
  GAS_PRICE: 'invalid gas price',
}));
vi.mock('../../hooks/useAI', () => ({
  useAI: () => ({ skuTiers: { phase: 'ready', tiers: [], denomSymbol: 'PWR', error: null } }),
}));
vi.mock('../../utils/errors', () => ({ logError: vi.fn() }));

describe('ConfirmationCard with invalid network fee configuration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function renderAction(overrides: Partial<PendingAction> = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const action: PendingAction = {
      id: 'fund-action',
      toolName: 'fund_credits',
      args: { amount: 10, address: 'manifest1test' },
      description: 'Add 10 credits?',
      originAddress: 'manifest1test',
      chainId: 'manifest-test',
      clientGeneration: 1,
      signerGeneration: 1,
      ...overrides,
    };
    flushSync(() => root.render(createElement(ConfirmationCard, { action, onConfirm, onCancel })));
    const buttons = [...container.querySelectorAll('button')];
    return {
      onConfirm,
      onCancel,
      confirm: buttons.find((button) => button.textContent?.trim() === 'Confirm')!,
      cancel: buttons.find((button) => button.textContent?.trim() === 'Cancel')!,
    };
  }

  it('keeps the card cancellable and blocks funding when its fee cannot be shown', () => {
    const { confirm, cancel, onConfirm, onCancel } = renderAction();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Network fee unavailable');
    expect(container.textContent).toContain('Add 10 credits?');
    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(false);
    confirm.click();
    cancel.click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('still permits provider operations that do not pay chain fees', () => {
    const { confirm, onConfirm } = renderAction({
      toolName: 'restart_app',
      args: { app_name: 'example', leaseUuid: 'lease-1', providerUrl: 'https://provider.example.com' },
      description: 'Restart example?',
    });

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(confirm.disabled).toBe(false);
    confirm.click();
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
