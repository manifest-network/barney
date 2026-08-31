import type { LeaseItem } from './billing';

/** A custom domain attached to a specific service (LeaseItem) in a lease. */
export interface DomainAssignment {
  /** The LeaseItem's service_name. Empty string for legacy single-item leases. */
  serviceName: string;
  /** The custom domain (FQDN) attached to that item. Always non-empty here. */
  customDomain: string;
}

/**
 * Read the custom-domain assignments for a lease's items.
 *
 * **This is the single seam that owns the chain's "1 custom_domain per LeaseItem"
 * cardinality on the *read* side.** Every consumer that needs to enumerate
 * which domains are attached to a lease should go through here:
 *   - `executeAppStatus` (compositeQueries.ts) — surfacing domains and emitting
 *     the CustomDomainCard.
 *   - `useRegistryReconciliation` — refreshing the durable registry cache from
 *     authoritative tenant lease-list records.
 *   - `executeSetCustomDomain` (compositeTransactions.ts) — looking up the
 *     current domain on the matched LeaseItem to decide attach / change / clear.
 *
 * Writers (`executeConfirmedSetCustomDomain`, `executeConfirmedDeployApp`
 * with `customDomain`) don't go through this seam — they hand off directly to
 * the SDK's `setItemCustomDomain` since each TX mutates one record.
 *
 * If the chain ever exposes `LeaseItem.customDomains: string[]` (SAN certs,
 * multiple aliases per service), `getDomainAssignments` becomes a `flatMap`
 * and the read consumers above keep working. The *write* boundary
 * (`MsgSetItemCustomDomain`, the AI tool schema, the success message) stays
 * single-domain because each TX still mutates one record. Read = many,
 * write = one is the correct asymmetry.
 */
export function getDomainAssignments(items: readonly LeaseItem[] | null | undefined): DomainAssignment[] {
  if (!items) return [];
  return items
    .filter(itemHasDomain)
    .map((item) => ({ serviceName: item.serviceName, customDomain: item.customDomain }));
}

/** Number of attached domains across the given items (0 in the typical case). */
export function getDomainCount(items: readonly LeaseItem[] | null | undefined): number {
  return getDomainAssignments(items).length;
}

/** Find the domain attached to a specific service. Returns `''` when none. */
export function getDomainForService(items: readonly LeaseItem[] | null | undefined, serviceName: string): string {
  if (!items) return '';
  const item = items.find((i) => i.serviceName === serviceName);
  return item?.customDomain ?? '';
}

function itemHasDomain(item: LeaseItem): boolean {
  return typeof item.customDomain === 'string' && item.customDomain !== '';
}
