/**
 * Progress tracking types for composite tool execution.
 * Used by deploy_app and other long-running operations to report
 * status updates to the UI.
 */

import type { FredLeaseStatus } from '../api/fred';

export interface DeployProgress {
  phase:
    | 'checking_credits'
    | 'funding'
    | 'creating_lease'
    | 'uploading'
    | 'provisioning'
    | 'ready'
    | 'failed';
  detail?: string;
  fredStatus?: FredLeaseStatus;
}
