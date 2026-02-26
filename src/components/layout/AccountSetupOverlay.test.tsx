import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { AccountSetupOverlay } from './AccountSetupOverlay';
import type { AccountSetupState } from '../../hooks/useAutoRefill';

let container: HTMLDivElement;
let root: Root;

function renderToContainer(state: AccountSetupState): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root.render(createElement(AccountSetupOverlay, { state }));
  });
  return container;
}

afterEach(() => {
  flushSync(() => { root?.unmount(); });
  container?.remove();
});

describe('AccountSetupOverlay', () => {
  it('renders nothing when isInitialSetup is false', () => {
    const el = renderToContainer({ isInitialSetup: false, phase: 'complete' });
    expect(el.innerHTML).toBe('');
  });

  it('renders overlay with alertdialog role when isInitialSetup is true', () => {
    const el = renderToContainer({ isInitialSetup: true, phase: 'checking' });
    const dialog = el.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
  });

  it('renders three steps', () => {
    const el = renderToContainer({ isInitialSetup: true, phase: 'checking' });
    const steps = el.querySelectorAll('.account-setup__step');
    expect(steps.length).toBe(3);
  });

  it('shows spinner on active step and circle on pending steps', () => {
    const el = renderToContainer({ isInitialSetup: true, phase: 'checking' });
    const steps = el.querySelectorAll('.account-setup__step');

    // First step (checking) should have spinning loader
    const firstStepSvg = steps[0].querySelector('.animate-spin');
    expect(firstStepSvg).not.toBeNull();

    // Second and third steps should NOT have spinner
    expect(steps[1].querySelector('.animate-spin')).toBeNull();
    expect(steps[2].querySelector('.animate-spin')).toBeNull();
  });

  it('shows checkmark on completed steps during faucet phase', () => {
    const el = renderToContainer({ isInitialSetup: true, phase: 'faucet' });
    const steps = el.querySelectorAll('.account-setup__step');

    // First step (checking) should be done — no spinner
    expect(steps[0].querySelector('.animate-spin')).toBeNull();

    // Second step (faucet) should have spinner
    expect(steps[1].querySelector('.animate-spin')).not.toBeNull();

    // Third step should be pending
    expect(steps[2].querySelector('.animate-spin')).toBeNull();
  });

  it('shows all checks on complete phase', () => {
    const el = renderToContainer({ isInitialSetup: true, phase: 'complete' });
    const steps = el.querySelectorAll('.account-setup__step');

    // No spinners anywhere
    expect(el.querySelector('.animate-spin')).toBeNull();

    // All steps should be done (no pending circles)
    steps.forEach((step) => {
      // Should have an SVG icon (CheckCircle)
      expect(step.querySelector('svg')).not.toBeNull();
    });
  });

  it('has no close button or escape handler', () => {
    const el = renderToContainer({ isInitialSetup: true, phase: 'checking' });

    // No buttons at all
    expect(el.querySelector('button')).toBeNull();

    // No elements with close-related classes
    expect(el.querySelector('.modal-close')).toBeNull();
    expect(el.querySelector('[aria-label="Close"]')).toBeNull();
  });

  it('renders the title', () => {
    const el = renderToContainer({ isInitialSetup: true, phase: 'checking' });
    const title = el.querySelector('.account-setup__title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe('Setting up your account');
  });

  it('shows XCircle icon on failed step with error', () => {
    const el = renderToContainer({ isInitialSetup: true, phase: 'faucet', error: 'Faucet failed' });
    const steps = el.querySelectorAll('.account-setup__step');

    // First step (checking) should be done — checkmark
    expect(steps[0].querySelector('.animate-spin')).toBeNull();
    expect(steps[0].querySelector('svg')).not.toBeNull();

    // Second step (faucet) should show error icon — no spinner
    expect(steps[1].querySelector('.animate-spin')).toBeNull();
    // Should have an SVG with error color
    const errorIcon = steps[1].querySelector('.text-\\[var\\(--color-error-400\\)\\]');
    expect(errorIcon).not.toBeNull();

    // Third step should be pending
    expect(steps[2].querySelector('.animate-spin')).toBeNull();
  });

  it('renders error message text', () => {
    const errorMsg = 'Could not add starter funds. Please try again later.';
    const el = renderToContainer({ isInitialSetup: true, phase: 'faucet', error: errorMsg });
    const errorEl = el.querySelector('.account-setup__error');
    expect(errorEl).not.toBeNull();
    expect(errorEl!.textContent).toBe(errorMsg);
  });

  it('does not render error element when no error', () => {
    const el = renderToContainer({ isInitialSetup: true, phase: 'faucet' });
    expect(el.querySelector('.account-setup__error')).toBeNull();
  });
});
