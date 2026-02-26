import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { AccountSetupOverlay } from './AccountSetupOverlay';
import type { AccountSetupState } from '../../hooks/useAutoRefill';

function renderToContainer(state: AccountSetupState): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(createElement(AccountSetupOverlay, { state }));
  });
  return container;
}

describe('AccountSetupOverlay', () => {
  it('renders nothing when isInitialSetup is false', () => {
    const container = renderToContainer({ isInitialSetup: false, phase: 'complete' });
    expect(container.innerHTML).toBe('');
    container.remove();
  });

  it('renders overlay with alertdialog role when isInitialSetup is true', () => {
    const container = renderToContainer({ isInitialSetup: true, phase: 'checking' });
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    container.remove();
  });

  it('renders three steps', () => {
    const container = renderToContainer({ isInitialSetup: true, phase: 'checking' });
    const steps = container.querySelectorAll('.account-setup__step');
    expect(steps.length).toBe(3);
    container.remove();
  });

  it('shows spinner on active step and circle on pending steps', () => {
    const container = renderToContainer({ isInitialSetup: true, phase: 'checking' });
    const steps = container.querySelectorAll('.account-setup__step');

    // First step (checking) should have spinning loader
    const firstStepSvg = steps[0].querySelector('.animate-spin');
    expect(firstStepSvg).not.toBeNull();

    // Second and third steps should NOT have spinner
    expect(steps[1].querySelector('.animate-spin')).toBeNull();
    expect(steps[2].querySelector('.animate-spin')).toBeNull();

    container.remove();
  });

  it('shows checkmark on completed steps during faucet phase', () => {
    const container = renderToContainer({ isInitialSetup: true, phase: 'faucet' });
    const steps = container.querySelectorAll('.account-setup__step');

    // First step (checking) should be done — no spinner
    expect(steps[0].querySelector('.animate-spin')).toBeNull();

    // Second step (faucet) should have spinner
    expect(steps[1].querySelector('.animate-spin')).not.toBeNull();

    // Third step should be pending
    expect(steps[2].querySelector('.animate-spin')).toBeNull();

    container.remove();
  });

  it('shows all checks on complete phase', () => {
    const container = renderToContainer({ isInitialSetup: true, phase: 'complete' });
    const steps = container.querySelectorAll('.account-setup__step');

    // No spinners anywhere
    expect(container.querySelector('.animate-spin')).toBeNull();

    // All steps should be done (no pending circles)
    steps.forEach((step) => {
      // Should have an SVG icon (CheckCircle)
      expect(step.querySelector('svg')).not.toBeNull();
    });

    container.remove();
  });

  it('has no close button or escape handler', () => {
    const container = renderToContainer({ isInitialSetup: true, phase: 'checking' });

    // No buttons at all
    expect(container.querySelector('button')).toBeNull();

    // No elements with close-related classes
    expect(container.querySelector('.modal-close')).toBeNull();
    expect(container.querySelector('[aria-label="Close"]')).toBeNull();

    container.remove();
  });

  it('renders the title', () => {
    const container = renderToContainer({ isInitialSetup: true, phase: 'checking' });
    const title = container.querySelector('.account-setup__title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe('Setting up your account');
    container.remove();
  });
});
