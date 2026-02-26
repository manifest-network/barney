import { Loader, CheckCircle, Circle } from 'lucide-react';
import type { AccountSetupState, SetupPhase } from '../../hooks/useAutoRefill';

interface AccountSetupOverlayProps {
  state: AccountSetupState;
}

const STEPS: { phase: SetupPhase; label: string }[] = [
  { phase: 'checking', label: 'Checking balances' },
  { phase: 'faucet', label: 'Sending tokens' },
  { phase: 'funding', label: 'Funding credits' },
];

const PHASE_ORDER: SetupPhase[] = ['checking', 'faucet', 'funding', 'complete'];

function stepStatus(stepPhase: SetupPhase, currentPhase: SetupPhase): 'done' | 'active' | 'pending' {
  const stepIdx = PHASE_ORDER.indexOf(stepPhase);
  const currentIdx = PHASE_ORDER.indexOf(currentPhase);
  if (currentIdx > stepIdx) return 'done';
  if (currentIdx === stepIdx) return 'active';
  return 'pending';
}

function StepIcon({ status }: { status: 'done' | 'active' | 'pending' }) {
  if (status === 'done') {
    return <CheckCircle className="w-5 h-5 text-[var(--accent)]" aria-hidden="true" />;
  }
  if (status === 'active') {
    return <Loader className="w-5 h-5 text-[var(--accent)] animate-spin" aria-hidden="true" />;
  }
  return <Circle className="w-5 h-5 text-[var(--text-tertiary)]" aria-hidden="true" />;
}

export function AccountSetupOverlay({ state }: AccountSetupOverlayProps) {
  if (!state.isInitialSetup) return null;

  return (
    <div className="modal-backdrop" role="alertdialog" aria-modal="true" aria-label="Setting up your account">
      <div className="account-setup">
        <h2 className="account-setup__title">Setting up your account</h2>
        <div className="account-setup__steps">
          {STEPS.map(({ phase, label }) => {
            const status = stepStatus(phase, state.phase);
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
      </div>
    </div>
  );
}
