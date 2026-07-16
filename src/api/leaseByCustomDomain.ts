import type { Lease } from './billing';
import { getReadClient } from './readClient';

export interface LeaseByCustomDomainResult {
  lease: Lease;
  leaseUuid: string;
  serviceName: string;
}

/**
 * Query the chain for a lease by its custom domain.
 * Returns null when no lease holds that domain (chain NOT_FOUND).
 *
 * ENG-536/537: the SDK read client's typed getLeaseByCustomDomain returns
 * `{ lease, serviceName } | null` — null on NOT_FOUND (grpc code:5), throw on a
 * transport failure — and decodes numeric enums, so barney no longer needs its
 * own LCD client / lcdConvert / fixEnumField / 404 string-matching.
 */
export async function queryLeaseByCustomDomain(
  fqdn: string,
): Promise<LeaseByCustomDomainResult | null> {
  const result = await (await getReadClient()).getLeaseByCustomDomain(fqdn);
  if (result === null) return null;
  return {
    lease: result.lease,
    leaseUuid: result.lease.uuid,
    serviceName: result.serviceName,
  };
}
