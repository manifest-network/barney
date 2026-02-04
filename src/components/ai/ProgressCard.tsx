/**
 * ProgressCard — renders deploy progress during deploy_app execution.
 * Driven by deployProgress from AIContext.
 */

import { memo } from 'react';
import { CheckCircle, Circle, Loader, AlertCircle } from 'lucide-react';
import type { DeployProgress } from '../../ai/progress';

interface ProgressCardProps {
  progress: DeployProgress;
}

const PHASES = [
  { key: 'checking_credits', label: 'Checking credits' },
  { key: 'creating_lease', label: 'Creating lease' },
  { key: 'uploading', label: 'Uploading manifest' },
  { key: 'provisioning', label: 'Provisioning' },
  { key: 'ready', label: 'Ready' },
] as const;

function getPhaseIndex(phase: string): number {
  return PHASES.findIndex((p) => p.key === phase);
}

export const ProgressCard = memo(function ProgressCard({ progress }: ProgressCardProps) {
  const currentIdx = getPhaseIndex(progress.phase);
  const isFailed = progress.phase === 'failed';
  const isReady = progress.phase === 'ready';

  return (
    <div
      className="progress-card"
      role="status"
      aria-label="Deployment progress"
    >
      <div className="progress-card__header">
        {isFailed ? (
          <AlertCircle className="w-5 h-5 text-error-400" aria-hidden="true" />
        ) : isReady ? (
          <CheckCircle className="w-5 h-5 text-success-400" aria-hidden="true" />
        ) : (
          <Loader className="w-5 h-5 text-primary-400 animate-spin" aria-hidden="true" />
        )}
        <span className="progress-card__title">
          {isFailed ? 'Deployment Failed' : isReady ? 'Deployed!' : 'Deploying...'}
        </span>
      </div>

      <div className="progress-card__steps">
        {PHASES.map((phase, idx) => {
          const isDone = idx < currentIdx || isReady;
          const isCurrent = idx === currentIdx && !isFailed && !isReady;
          return (
            <div key={phase.key} className="progress-card__step">
              {isDone ? (
                <CheckCircle className="w-4 h-4 text-success-400" aria-hidden="true" />
              ) : isCurrent ? (
                <Loader className="w-4 h-4 text-primary-400 animate-spin" aria-hidden="true" />
              ) : (
                <Circle className="w-4 h-4 text-surface-500" aria-hidden="true" />
              )}
              <span className={`progress-card__step-label ${isDone ? 'text-success-400' : isCurrent ? 'text-primary' : 'text-muted'}`}>
                {phase.label}
              </span>
            </div>
          );
        })}
      </div>

      {progress.detail && (
        <p className="progress-card__detail">{progress.detail}</p>
      )}

      {progress.fredStatus?.phase && (
        <p className="progress-card__substep">
          {progress.fredStatus.phase}
        </p>
      )}
    </div>
  );
});
