import { liftedinit } from '@manifest-network/manifestjs';
import type { QueryLeaseByCustomDomainResponse } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/query';
import type { Lease } from './billing';
import { fixEnumField, getQueryClient, lcdConvert, queryWithNotFound } from './queryClient';

const { QueryLeaseByCustomDomainResponse: QueryLeaseByCustomDomainResponseConverter, leaseStateFromJSON } =
  liftedinit.billing.v1;

function fixLeaseEnums(lease: Lease): Lease {
  return fixEnumField(lease, 'state', leaseStateFromJSON);
}

export interface LeaseByCustomDomainResult {
  lease: Lease;
  leaseUuid: string;
  serviceName: string;
}

/**
 * Query the chain for a lease by its custom domain.
 * Returns null when no lease holds that domain (chain 404).
 */
export async function queryLeaseByCustomDomain(
  fqdn: string,
): Promise<LeaseByCustomDomainResult | null> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.billing.v1.leaseByCustomDomain({ customDomain: fqdn }),
    null,
  );
  if (!data) return null;

  const converted: QueryLeaseByCustomDomainResponse = lcdConvert(
    data,
    QueryLeaseByCustomDomainResponseConverter,
  );

  const lease = fixLeaseEnums(converted.lease);
  return {
    lease,
    leaseUuid: lease.uuid,
    serviceName: converted.serviceName,
  };
}
