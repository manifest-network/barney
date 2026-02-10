/**
 * ProgressCard — renders deploy progress during deploy_app execution.
 * Driven by deployProgress from AIContext.
 */

import { memo, useState, useEffect, useRef } from 'react';
import { CheckCircle, Circle, Loader, AlertCircle, RotateCcw } from 'lucide-react';
import type { DeployProgress } from '../../ai/progress';

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

interface ProgressCardProps {
  progress: DeployProgress;
  onRetry?: () => void;
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

export const ProgressCard = memo(function ProgressCard({ progress, onRetry }: ProgressCardProps) {
  const currentIdx = getPhaseIndex(progress.phase);
  const isFailed = progress.phase === 'failed';
  const isReady = progress.phase === 'ready';
  const isTerminal = isFailed || isReady;

  // Derive operation type from progress.operation (set by executors) or phase
  const operation = progress.operation ?? 'deploy';
  const isSimpleOperation = operation === 'restart' || operation === 'update';

  const startRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  // Reset timer when a new operation starts (isTerminal becomes false).
  useEffect(() => {
    if (isTerminal) return;
    startRef.current = Date.now();
    const tick = () => setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    const resetId = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => { clearTimeout(resetId); clearInterval(id); };
  }, [isTerminal]);

  // Contextual titles based on operation type
  const titles = {
    restart: { active: 'Restarting...', ready: 'Restarted!', failed: 'Restart Failed' },
    update: { active: 'Updating...', ready: 'Updated!', failed: 'Update Failed' },
    deploy: { active: 'Deploying...', ready: 'Deployed!', failed: 'Deployment Failed' },
  };
  const title = isFailed
    ? titles[operation].failed
    : isReady
      ? titles[operation].ready
      : titles[operation].active;

  // Build a concise screen-reader announcement for the current phase
  const phaseLabel = isFailed
    ? `${titles[operation].failed}${progress.detail ? `: ${progress.detail}` : ''}`
    : isReady
      ? titles[operation].ready
      : isSimpleOperation
        ? titles[operation].active
        : PHASES[currentIdx]?.label ?? 'Deploying';

  return (
    <div
      className="progress-card"
      role="status"
      aria-label="Deployment progress"
    >
      {/* Screen-reader announcement: assertive for terminal, polite for in-progress */}
      <span className="sr-only" aria-live={isTerminal ? 'assertive' : 'polite'}>
        {phaseLabel}
      </span>
      <div className="progress-card__header">
        {phaseIcon(progress.phase, 'w-5 h-5')}
        <span className="progress-card__title">
          {title}
        </span>
        {elapsed > 0 && (
          <span className="progress-card__elapsed">{formatElapsed(elapsed)}</span>
        )}
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
      ) : isSimpleOperation ? (
        <div className="progress-card__steps">
          <div className="progress-card__step">
            {isReady ? (
              <CheckCircle className="w-4 h-4 text-success-400" aria-hidden="true" />
            ) : isFailed ? (
              <AlertCircle className="w-4 h-4 text-error-400" aria-hidden="true" />
            ) : (
              <Loader className="w-4 h-4 text-primary-400 animate-spin" aria-hidden="true" />
            )}
            <span className={`progress-card__step-label ${isReady ? 'text-success-400' : isFailed ? 'text-error-400' : 'text-primary'}`}>
              {progress.detail || titles[operation].active}
            </span>
          </div>
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

      {progress.detail && !isSimpleOperation && (
        <p className="progress-card__detail">{progress.detail}</p>
      )}

      {progress.fredStatus?.phase && (
        <p className="progress-card__substep">
          {progress.fredStatus.phase}
        </p>
      )}

      {isFailed && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="progress-card__retry"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          Retry
        </button>
      )}
    </div>
  );
});
