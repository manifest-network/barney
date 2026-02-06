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

function phaseIcon(phase: string, size: string = 'w-4 h-4') {
  if (phase === 'ready') return <CheckCircle className={`${size} text-success-400`} aria-hidden="true" />;
  if (phase === 'failed') return <AlertCircle className={`${size} text-error-400`} aria-hidden="true" />;
  return <Loader className={`${size} text-primary-400 animate-spin`} aria-hidden="true" />;
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
        {phaseIcon(progress.phase, 'w-5 h-5')}
        <span className="progress-card__title">
          {isFailed ? 'Deployment Failed' : isReady ? 'Deployed!' : 'Deploying...'}
        </span>
      </div>

      {progress.batch ? (
        <div className="progress-card__batch">
          {progress.batch.map((app) => (
            <div key={app.name} className="progress-card__batch-item">
              {phaseIcon(app.phase)}
              <span className="progress-card__batch-name">{app.name}</span>
              <span className="text-muted">{app.detail || app.phase}</span>
            </div>
          ))}
        </div>
      ) : (
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
      )}

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
