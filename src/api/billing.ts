import { liftedinit } from '@manifest-network/manifestjs';
import type {
  Params as BillingParams,
  Lease,
  LeaseItem,
  CreditAccount,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types';
import type {
  QueryCreditAccountResponse,
  QueryCreditEstimateResponse,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/query';
import type { PageResponse } from '@manifest-network/manifestjs/dist/codegen/cosmos/base/query/v1beta1/pagination';
import { isNotFoundError } from '@manifest-network/manifest-sdk';
import { getReadClient } from './readClient';

// Re-export manifestjs types for consumers (Coin is exported from bank.ts)
export type { BillingParams, Lease, LeaseItem, CreditAccount };
export type { QueryCreditEstimateResponse, QueryCreditAccountResponse };

// Re-export LeaseState enum from manifestjs for type safety
export const LeaseState = liftedinit.billing.v1.LeaseState;
export type LeaseState = (typeof LeaseState)[keyof typeof LeaseState];

// Conversion functions from manifestjs
const { leaseStateFromJSON: fromJSON, leaseStateToJSON: toJSON } = liftedinit.billing.v1;

export function leaseStateToString(state: LeaseState): string {
  return toJSON(state);
}

export function leaseStateFromString(state: string): LeaseState {
  return fromJSON(state);
}

export const LEASE_STATE_MAP: Record<string, LeaseState> = {
  pending: LeaseState.LEASE_STATE_PENDING,
  active: LeaseState.LEASE_STATE_ACTIVE,
  closed: LeaseState.LEASE_STATE_CLOSED,
  rejected: LeaseState.LEASE_STATE_REJECTED,
  expired: LeaseState.LEASE_STATE_EXPIRED,
};

export const LEASE_STATE_FILTERS = ['all', ...Object.keys(LEASE_STATE_MAP)] as const;

// The typed read defaults limit to 50; barney's un-paginated "list a tenant's
// leases" must not silently truncate (list_apps reconcile). A wallet realistically
// holds far fewer than this cap.
const LEASES_LIST_LIMIT = 1000n;

// ENG-536/537: all reads go through the SDK read client. Typed methods (getLease,
// getLeasesByTenant, getBillingParams) return branded, numeric-enum-decoded data;
// the credit family has no typed method and rides `client.query` (the LCD-adapter
// drop-down — same numeric-enum decode). Not-found surfaces as a classified
// NOT_FOUND error (grpc code:5), detected with isNotFoundError. No lcdConvert /
// fixEnumField / queryWithNotFound / parallel LCD client.

export async function getCreditAccount(tenant: string): Promise<QueryCreditAccountResponse> {
  const client = await getReadClient();
  try {
    return await client.query.liftedinit.billing.v1.creditAccount({ tenant });
  } catch (error) {
    if (isNotFoundError(error)) {
      // No credit account yet (every new user) — synthesize a zero-account.
      // Product policy that stays in barney (the SDK's composite getBalance
      // returns credits:null; barney prefers a zero-shaped account here).
      // The creditAddress query only runs on this cold-start branch — the
      // happy path issues a single query, not two.
      const creditAddress = await getCreditAddress(tenant);
      return {
        creditAccount: {
          tenant,
          creditAddress,
          activeLeaseCount: 0n,
          pendingLeaseCount: 0n,
          reservedAmounts: [],
        },
        balances: [],
        availableBalances: [],
      };
    }
    throw error;
  }
}

export async function getCreditAddress(tenant: string): Promise<string> {
  const client = await getReadClient();
  const data = await client.query.liftedinit.billing.v1.creditAddress({ tenant });
  return data.creditAddress;
}

export async function getCreditEstimate(tenant: string): Promise<QueryCreditEstimateResponse | null> {
  const client = await getReadClient();
  try {
    return await client.query.liftedinit.billing.v1.creditEstimate({ tenant });
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function getBillingParams(): Promise<BillingParams> {
  const client = await getReadClient();
  return client.getBillingParams();
}

export async function getLeasesByTenant(tenant: string, stateFilter?: LeaseState): Promise<Lease[]> {
  const client = await getReadClient();
  const { leases } = await client.getLeasesByTenant({
    tenant,
    stateFilter: stateFilter ?? LeaseState.LEASE_STATE_UNSPECIFIED,
    limit: LEASES_LIST_LIMIT,
  });
  return leases;
}

export async function getLeasesByTenantPaginated(
  tenant: string,
  params?: { stateFilter?: LeaseState; limit?: number; offset?: number; reverse?: boolean }
): Promise<PaginatedLeasesResponse> {
  const client = await getReadClient();
  const { leases, total } = await client.getLeasesByTenant({
    tenant,
    stateFilter: params?.stateFilter ?? LeaseState.LEASE_STATE_UNSPECIFIED,
    limit: params?.limit !== undefined ? BigInt(params.limit) : undefined,
    offset: params?.offset !== undefined ? BigInt(params.offset) : undefined,
    reverse: params?.reverse,
  });
  // The typed read returns { leases, total }; barney's shape carries a PageResponse.
  // Only `pagination.total` is consumed (lease_history), so a minimal envelope suffices.
  return {
    leases,
    pagination: { nextKey: new Uint8Array(), total },
  };
}

export async function getLease(leaseUuid: string): Promise<Lease | null> {
  const client = await getReadClient();
  return client.getLease(leaseUuid);
}

export interface PaginatedLeasesResponse {
  leases: Lease[];
  pagination?: PageResponse;
}
