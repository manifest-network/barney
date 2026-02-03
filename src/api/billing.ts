/* eslint-disable @typescript-eslint/no-explicit-any -- LCD returns untyped JSON; `as any` is needed for fromAmino() */
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
import type { Coin } from '@manifest-network/manifestjs/dist/codegen/cosmos/base/v1beta1/coin';
import type { PageResponse } from '@manifest-network/manifestjs/dist/codegen/cosmos/base/query/v1beta1/pagination';
import { getQueryClient, queryWithNotFound } from './queryClient';
import { logError } from '../utils/errors';

// Re-export manifestjs types for consumers
export type { BillingParams, Lease, LeaseItem, CreditAccount, Coin };
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
  QueryWithdrawableAmountResponse: QueryWithdrawableAmountResponseConverter,
  QueryProviderWithdrawableResponse: QueryProviderWithdrawableResponseConverter,
  QueryCreditAccountsResponse: QueryCreditAccountsResponseConverter,
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
  return { ...lease, state: fromJSON(lease.state) };
}

export async function getCreditAccount(tenant: string): Promise<QueryCreditAccountResponse> {
  const creditAddress = await getCreditAddress(tenant);

  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.billing.v1.creditAccount({ tenant }),
    null,
  );

  if (data) {
    const converted = QueryCreditAccountResponseConverter.fromAmino(data as any);
    return converted;
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
  const converted = QueryCreditAddressResponseConverter.fromAmino(data as any);
  return converted.creditAddress;
}

export async function getCreditEstimate(tenant: string): Promise<QueryCreditEstimateResponse | null> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.billing.v1.creditEstimate({ tenant }),
    null,
  );
  if (!data) return null;
  return QueryCreditEstimateResponseConverter.fromAmino(data as any);
}

export async function getBillingParams(): Promise<BillingParams> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.params();
  const converted = QueryParamsResponseConverter.fromAmino(data as any);
  return converted.params;
}

export async function getLeasesByTenant(tenant: string, stateFilter?: LeaseState): Promise<Lease[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.leasesByTenant({
    tenant,
    stateFilter: stateFilter ?? LeaseState.LEASE_STATE_UNSPECIFIED,
  });
  const converted = QueryLeasesResponseConverter.fromAmino(data as any);
  return converted.leases.map(fixLeaseEnums);
}

export async function getLeasesByProvider(providerUuid: string, stateFilter?: LeaseState): Promise<Lease[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.leasesByProvider({
    providerUuid,
    stateFilter: stateFilter ?? LeaseState.LEASE_STATE_UNSPECIFIED,
  });
  const converted = QueryLeasesResponseConverter.fromAmino(data as any);
  return converted.leases.map(fixLeaseEnums);
}

export async function getLease(leaseUuid: string): Promise<Lease | null> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.billing.v1.lease({ leaseUuid }),
    null,
  );
  if (!data) return null;
  const converted = QueryLeaseResponseConverter.fromAmino(data as any);
  return fixLeaseEnums(converted.lease);
}

export async function getWithdrawableAmount(leaseUuid: string): Promise<Coin[]> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.billing.v1.withdrawableAmount({ leaseUuid }),
    null,
  );
  if (!data) return [];
  const converted = QueryWithdrawableAmountResponseConverter.fromAmino(data as any);
  return converted.amounts;
}

export async function getProviderWithdrawable(providerUuid: string): Promise<QueryProviderWithdrawableResponse> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.billing.v1.providerWithdrawable({ providerUuid, limit: BigInt(0) }),
    null,
  );
  if (!data) return { amounts: [], leaseCount: 0n, hasMore: false };
  return QueryProviderWithdrawableResponseConverter.fromAmino(data as any);
}

export async function getLeasesBySKU(skuUuid: string, stateFilter?: LeaseState): Promise<Lease[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.leasesBySKU({
    skuUuid,
    stateFilter: stateFilter ?? LeaseState.LEASE_STATE_UNSPECIFIED,
  });
  const converted = QueryLeasesResponseConverter.fromAmino(data as any);
  return converted.leases.map(fixLeaseEnums);
}

export interface PaginatedLeasesResponse {
  leases: Lease[];
  pagination?: PageResponse;
}

export interface GetAllLeasesParams {
  stateFilter?: LeaseState;
  limit?: number;
  offset?: number;
  paginationKey?: string;
}

function buildPageRequest(params?: { limit?: number; offset?: number; paginationKey?: string; countTotal?: boolean }) {
  if (!params) return undefined;
  return {
    key: new Uint8Array(),
    offset: BigInt(params.offset ?? 0),
    limit: BigInt(params.limit ?? 0),
    countTotal: params.countTotal ?? false,
    reverse: false,
  };
}

export async function getAllLeases(params?: GetAllLeasesParams): Promise<PaginatedLeasesResponse> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.leases({
    pagination: buildPageRequest({
      limit: params?.limit,
      offset: params?.offset,
      paginationKey: params?.paginationKey,
      countTotal: !!params?.limit,
    }),
    stateFilter: params?.stateFilter ?? LeaseState.LEASE_STATE_UNSPECIFIED,
  });

  const converted = QueryLeasesResponseConverter.fromAmino(data as any);

  return {
    leases: converted.leases.map(fixLeaseEnums),
    pagination: converted.pagination,
  };
}

export interface PaginatedCreditsResponse {
  creditAccounts: CreditAccount[];
  balances: Record<string, Coin[]>;
  pagination?: PageResponse;
}

export interface GetAllCreditsParams {
  limit?: number;
  offset?: number;
  paginationKey?: string;
}

/**
 * Fetches all credit accounts with their balances.
 *
 * **N+1 Query Pattern:** The billing bulk API (`/credits`) doesn't include balance data,
 * so we make additional requests to the bank module for each credit account's balance.
 * With pagination (default PAGE_SIZE=10), this results in up to 10 parallel HTTP requests
 * per page load.
 *
 * **Tradeoffs:**
 * - Balances are fetched in parallel via Promise.all for performance
 * - Individual balance fetch errors are logged (dev mode) but don't fail the entire request
 * - This is acceptable for current pagination sizes but could become a bottleneck if:
 *   - Page size increases significantly (>20-30 accounts)
 *   - This pattern is replicated elsewhere without consideration
 */
export async function getAllCredits(params?: GetAllCreditsParams): Promise<PaginatedCreditsResponse> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.creditAccounts({
    pagination: buildPageRequest({
      limit: params?.limit,
      offset: params?.offset,
      paginationKey: params?.paginationKey,
      countTotal: !!params?.limit,
    }),
  });

  const converted = QueryCreditAccountsResponseConverter.fromAmino(data as any);
  const creditAccounts = converted.creditAccounts;

  // N+1 query: fetch balances from bank module (see function docs for rationale)
  const balances: Record<string, Coin[]> = {};

  if (creditAccounts.length > 0) {
    const balancePromises = creditAccounts.map(async (account) => {
      try {
        const balanceData = await client.cosmos.bank.v1beta1.allBalances({ address: account.creditAddress, resolveDenom: false });
        return { key: account.creditAddress, balances: (balanceData.balances ?? []) as Coin[] };
      } catch (error) {
        logError('billing.getAllCredits.fetchBalance', error);
        return { key: account.creditAddress, balances: [] as Coin[] };
      }
    });

    const results = await Promise.all(balancePromises);
    for (const result of results) {
      balances[result.key] = result.balances;
    }
  }

  return {
    creditAccounts,
    balances,
    pagination: converted.pagination,
  };
}
