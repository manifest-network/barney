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
  QueryProviderWithdrawableResponse,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/query';
import type { PageResponse } from '@manifest-network/manifestjs/dist/codegen/cosmos/base/query/v1beta1/pagination';
import { getQueryClient, queryWithNotFound, lcdConvert, fixEnumField } from './queryClient';

// Re-export manifestjs types for consumers (Coin is exported from bank.ts)
export type { BillingParams, Lease, LeaseItem, CreditAccount };
export type { QueryCreditEstimateResponse, QueryCreditAccountResponse, QueryProviderWithdrawableResponse };

// Re-export LeaseState enum from manifestjs for type safety
export const LeaseState = liftedinit.billing.v1.LeaseState;
export type LeaseState = (typeof LeaseState)[keyof typeof LeaseState];

// Conversion functions from manifestjs
const { leaseStateFromJSON: fromJSON, leaseStateToJSON: toJSON } = liftedinit.billing.v1;

// fromAmino converters for query responses
const {
  QueryParamsResponse: QueryParamsResponseConverter,
  QueryLeaseResponse: QueryLeaseResponseConverter,
  QueryLeasesResponse: QueryLeasesResponseConverter,
  QueryCreditAccountResponse: QueryCreditAccountResponseConverter,
  QueryCreditAddressResponse: QueryCreditAddressResponseConverter,
  QueryCreditEstimateResponse: QueryCreditEstimateResponseConverter,
} = liftedinit.billing.v1;

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

// fromAmino doesn't convert enum strings to numeric values; LCD returns strings like "LEASE_STATE_ACTIVE"
// but LeaseState enum keys are numeric (0, 1, 2, ...). This fixes the mismatch.
function fixLeaseEnums(lease: Lease): Lease {
  return fixEnumField(lease, 'state', fromJSON);
}

export async function getCreditAccount(tenant: string): Promise<QueryCreditAccountResponse> {
  const creditAddress = await getCreditAddress(tenant);

  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.billing.v1.creditAccount({ tenant }),
    null,
  );

  if (data) {
    return lcdConvert(data, QueryCreditAccountResponseConverter);
  }

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

export async function getCreditAddress(tenant: string): Promise<string> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.creditAddress({ tenant });
  return lcdConvert(data, QueryCreditAddressResponseConverter).creditAddress;
}

export async function getCreditEstimate(tenant: string): Promise<QueryCreditEstimateResponse | null> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.billing.v1.creditEstimate({ tenant }),
    null,
  );
  if (!data) return null;
  return lcdConvert(data, QueryCreditEstimateResponseConverter);
}

export async function getBillingParams(): Promise<BillingParams> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.params();
  return lcdConvert(data, QueryParamsResponseConverter).params;
}

export async function getLeasesByTenant(tenant: string, stateFilter?: LeaseState): Promise<Lease[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.leasesByTenant({
    tenant,
    stateFilter: stateFilter ?? LeaseState.LEASE_STATE_UNSPECIFIED,
  });
  return lcdConvert(data, QueryLeasesResponseConverter).leases.map(fixLeaseEnums);
}

export async function getLeasesByTenantPaginated(
  tenant: string,
  params?: { stateFilter?: LeaseState; limit?: number; offset?: number; reverse?: boolean }
): Promise<PaginatedLeasesResponse> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.leasesByTenant({
    tenant,
    stateFilter: params?.stateFilter ?? LeaseState.LEASE_STATE_UNSPECIFIED,
    pagination: buildPageRequest({
      limit: params?.limit,
      offset: params?.offset,
      countTotal: true,
      reverse: params?.reverse,
    }),
  });
  const converted = lcdConvert(data, QueryLeasesResponseConverter);
  return {
    leases: converted.leases.map(fixLeaseEnums),
    pagination: converted.pagination,
  };
}

export async function getLease(leaseUuid: string): Promise<Lease | null> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.billing.v1.lease({ leaseUuid }),
    null,
  );
  if (!data) return null;
  return fixLeaseEnums(lcdConvert(data, QueryLeaseResponseConverter).lease);
}

export interface PaginatedLeasesResponse {
  leases: Lease[];
  pagination?: PageResponse;
}

function buildPageRequest(params?: { limit?: number; offset?: number; countTotal?: boolean; reverse?: boolean }) {
  if (!params) return undefined;
  return {
    key: new Uint8Array(),
    offset: BigInt(params.offset ?? 0),
    limit: BigInt(params.limit ?? 0),
    countTotal: params.countTotal ?? false,
    reverse: params.reverse ?? false,
  };
}

