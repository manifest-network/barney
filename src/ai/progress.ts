/**
 * Progress tracking types for composite tool execution.
 * Used by deploy_app and other long-running operations to report
 * status updates to the UI.
 */

import type { FredLeaseStatus } from '../api/fred';
import { logError } from '../utils/errors';

export interface DeployProgress {
  phase:
    | 'creating_lease'
    | 'uploading'
    | 'provisioning'
    | 'restarting'
    | 'updating'
    | 'ready'
    | 'failed';
  detail?: string;
  fredStatus?: FredLeaseStatus;
  /** Operation type — set by executors for restart/update so ProgressCard shows the right UI */
  operation?: 'deploy' | 'restart' | 'update';
  /** Per-app progress for batch deploys */
  batch?: Array<{
    name: string;
    phase: DeployProgress['phase'];
    detail?: string;
  }>;
}

/** Progress observers must not interrupt a paid deployment, even if they reject asynchronously. */
export function createProgressReporter(onProgress?: (progress: DeployProgress) => void) {
  return (progress: DeployProgress): void => {
    if (!onProgress) return;
    try {
      void Promise.resolve(onProgress(progress)).catch((error) => {
        logError('progress.onProgress', error);
      });
    } catch (error) {
      logError('progress.onProgress', error);
    }
  };
}
