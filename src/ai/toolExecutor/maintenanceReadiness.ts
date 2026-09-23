import type { AppEntry } from '../../registry/appRegistry';
import { classifyProvisionStatus } from './provisionStatus';

/** Command settlement and runtime readiness are independent observations. */
export function maintenanceReadinessPatch(status: string | undefined, snapshot: AppEntry | null | undefined): Partial<AppEntry> {
  const provisionState = classifyProvisionStatus(status);
  // Retained is an explicit teardown verdict, represented as unconfirmed in
  // the registry because only the deployment's volumes remain.
  if (provisionState === 'confirmed' || provisionState === 'failed' || status === 'retained') {
    return { provisionState, ...(snapshot?.readinessStale && { readinessStale: false }) };
  }
  // Progress, missing, and unrecognised statuses cannot retract a prior verdict
  // or turn the command's failure into a claim about the current runtime.
  return { readinessStale: true };
}
