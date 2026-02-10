/**
 * Progress tracking types for composite tool execution.
 * Used by deploy_app and other long-running operations to report
 * status updates to the UI.
 */

import type { FredLeaseStatus } from '../api/fred';
import type { PayloadAttachment } from './toolExecutor';

export interface DeployProgress {
  phase:
    | 'checking_credits'
    | 'funding'
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
  /** Original manifest payload preserved on failure for retry */
  payload?: PayloadAttachment;
}
