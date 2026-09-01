import type { LeaseItem } from './billing';
import { getLease } from './billing';

/**
 * Fetch the LeaseItem array for a given lease UUID.
 *
 * `null` means the lease was not found; `[]` means the lease exists and has no
 * items. Callers that reconcile cached state must preserve that distinction so
 * a temporarily inconsistent RPC cannot masquerade as an authoritative empty
 * item set.
 */
export async function getLeaseItemsForLease(leaseUuid: string): Promise<LeaseItem[] | null> {
  const lease = await getLease(leaseUuid);
  return lease ? (lease.items ?? []) : null;
}
