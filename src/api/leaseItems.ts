import type { LeaseItem } from './billing';
import { getLease } from './billing';

/** Fetch the LeaseItem array for a given lease UUID. Returns [] if not found. */
export async function getLeaseItemsForLease(leaseUuid: string): Promise<LeaseItem[]> {
  const lease = await getLease(leaseUuid);
  return lease?.items ?? [];
}
