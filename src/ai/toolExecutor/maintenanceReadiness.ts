import type { AppEntry } from '../../registry/appRegistry';
import { provisionObservationPatch } from './provisionStatus';

/** Command settlement and runtime readiness are independent observations. */
export function maintenanceReadinessPatch(status: string | undefined, snapshot: AppEntry | null | undefined): Partial<AppEntry> {
  return provisionObservationPatch(status, snapshot);
}
