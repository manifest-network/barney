import { useEffect, useRef } from 'react';
import { FocusTrap } from 'focus-trap-react';
import { Loader, CheckCircle, Circle, XCircle } from 'lucide-react';
import type { AccountSetupState, SetupPhase } from '../../hooks/useAccountSetup';

interface AccountSetupOverlayProps {
  state: AccountSetupState;
}

const STEPS: { phase: SetupPhase; label: string }[] = [
  { phase: 'checking', label: 'Preparing your account' },
  { phase: 'faucet', label: 'Adding starter funds' },
  { phase: 'funding', label: 'Activating credits' },
];

const PHASE_ORDER: SetupPhase[] = ['checking', 'faucet', 'funding', 'complete'];

function stepStatus(stepPhase: SetupPhase, currentPhase: SetupPhase, hasError: boolean): 'done' | 'active' | 'pending' | 'error' {
  const stepIdx = PHASE_ORDER.indexOf(stepPhase);
  const currentIdx = PHASE_ORDER.indexOf(currentPhase);
  if (currentIdx > stepIdx) return 'done';
  if (currentIdx === stepIdx) return hasError ? 'error' : 'active';
  return 'pending';
}

function StepIcon({ status }: { status: 'done' | 'active' | 'pending' | 'error' }) {
  if (status === 'done') {
    return <CheckCircle className="w-5 h-5 text-[var(--accent)]" aria-hidden="true" />;
  }
  if (status === 'active') {
    return <Loader className="w-5 h-5 text-[var(--accent)] animate-spin" aria-hidden="true" />;
  }
  if (status === 'error') {
    return <XCircle className="w-5 h-5 text-[var(--color-error-400)]" aria-hidden="true" />;
  }
  return <Circle className="w-5 h-5 text-[var(--text-tertiary)]" aria-hidden="true" />;
}

export function AccountSetupOverlay({ state }: AccountSetupOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Prevent body scrolling while overlay is visible
  useEffect(() => {
    if (!state.isInitialSetup) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [state.isInitialSetup]);

  if (!state.isInitialSetup) return null;

  const hasError = !!state.error;

  return (
    // Non-dismissible overlay with zero focusable children — trap focus so Tab
    // can't escape to the background app during blocking provisioning. Both
    // initialFocus and fallbackFocus target the dialog container (fallbackFocus
    // is REQUIRED, or FocusTrap throws when there's nothing focusable inside).
    <FocusTrap
      focusTrapOptions={{
        escapeDeactivates: false,
        clickOutsideDeactivates: false,
        initialFocus: () => dialogRef.current!,
        fallbackFocus: () => dialogRef.current!,
        returnFocusOnDeactivate: true,
      }}
    >
      <div ref={dialogRef} className="modal-backdrop" role="alertdialog" aria-modal="true" aria-label="Setting up your account" tabIndex={-1}>
        <div className="account-setup">
          <h2 className="account-setup__title">Setting up your account</h2>
          <div className="account-setup__steps">
            {STEPS.map(({ phase, label }) => {
              const status = stepStatus(phase, state.phase, hasError);
              return (
                <div key={phase} className="account-setup__step">
                  <StepIcon status={status} />
                  <span className={status === 'pending' ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
          {state.error && (
            <p className="account-setup__error">{state.error}</p>
          )}
        </div>
      </div>
    </FocusTrap>
  );
}
