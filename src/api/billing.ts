import { liftedinit } from '@manifest-network/manifestjs';
import { getQueryClient, queryWithNotFound } from './queryClient';
import { logError } from '../utils/errors';
import type { Coin } from './bank';

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

export interface LeaseItem {
  sku_uuid: string;
  quantity: string;
  locked_price: Coin;
}

export interface Lease {
  uuid: string;
  tenant: string;
  provider_uuid: string;
  items: LeaseItem[];
  state: LeaseState;
  created_at: string;
  last_settled_at: string;
  closed_at?: string | null;
  acknowledged_at?: string | null;
  rejected_at?: string | null;
  expired_at?: string | null;
  rejection_reason?: string | null;
  closure_reason?: string | null;
  min_lease_duration_at_creation?: string | null;
  meta_hash?: string | null;
}

interface RawLease {
  uuid: string;
  tenant: string;
  provider_uuid: string;
  items: LeaseItem[];
  state: string;
  created_at: string;
  last_settled_at: string;
  closed_at?: string | null;
  acknowledged_at?: string | null;
  rejected_at?: string | null;
  expired_at?: string | null;
  rejection_reason?: string | null;
  closure_reason?: string | null;
  min_lease_duration_at_creation?: string | null;
  meta_hash?: string | null;
}

function parseLease(raw: RawLease): Lease {
  return {
    ...raw,
    state: fromJSON(raw.state),
  };
}

function parseLeases(raw: RawLease[]): Lease[] {
  return raw.map(parseLease);
}

export interface BillingParams {
  max_leases_per_tenant: string;
  allowed_list: string[];
  max_items_per_lease: string;
  min_lease_duration: string;
  max_pending_leases_per_tenant: string;
  pending_timeout: string;
}

export interface BillingParamsResponse {
  params: BillingParams;
}

export interface CreditAccount {
  tenant: string;
  credit_address: string;
  active_lease_count: number;
  pending_lease_count: number;
}

export interface CreditAccountResponse {
  credit_account: CreditAccount;
  balances: Coin[];
}

export interface CreditAddressResponse {
  credit_address: string;
}

export interface CreditEstimateResponse {
  current_balance: Coin[];
  total_rate_per_second: Coin[];
  estimated_duration_seconds: string;
  active_lease_count: string;
}

function parseCreditAccount(raw: unknown): CreditAccount {
  const r = raw as Record<string, unknown>;
  return {
    tenant: String(r.tenant),
    credit_address: String(r.credit_address),
    active_lease_count: Number(r.active_lease_count),
    pending_lease_count: Number(r.pending_lease_count),
  };
}

export async function getCreditAccount(tenant: string): Promise<CreditAccountResponse> {
  const creditAddress = await getCreditAddress(tenant);

  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.billing.v1.creditAccount({ tenant }),
    null,
  );

  if (data) {
    return {
      credit_account: parseCreditAccount(data.credit_account),
      balances: (data.balances ?? []) as unknown as Coin[],
    };
  }

  return {
    credit_account: {
      tenant,
      credit_address: creditAddress,
      active_lease_count: 0,
      pending_lease_count: 0,
    },
    balances: [],
  };
}

export async function getCreditAddress(tenant: string): Promise<string> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.creditAddress({ tenant });
  return data.credit_address;
}

export async function getCreditEstimate(tenant: string): Promise<CreditEstimateResponse | null> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.billing.v1.creditEstimate({ tenant }),
    null,
  );
  if (!data) return null;
  return data as unknown as CreditEstimateResponse;
}

export async function getBillingParams(): Promise<BillingParams> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.params();
  return data.params as unknown as BillingParams;
}

export async function getLeasesByTenant(tenant: string, stateFilter?: LeaseState): Promise<Lease[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.leasesByTenant({
    tenant,
    stateFilter: stateFilter ?? LeaseState.LEASE_STATE_UNSPECIFIED,
  });
  return parseLeases((data.leases ?? []) as unknown as RawLease[]);
}

export async function getLeasesByProvider(providerUuid: string, stateFilter?: LeaseState): Promise<Lease[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.leasesByProvider({
    providerUuid,
    stateFilter: stateFilter ?? LeaseState.LEASE_STATE_UNSPECIFIED,
  });
  return parseLeases((data.leases ?? []) as unknown as RawLease[]);
}

export async function getLease(leaseUuid: string): Promise<Lease | null> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.billing.v1.lease({ leaseUuid }),
    null,
  );
  if (!data) return null;
  return parseLease(data.lease as unknown as RawLease);
}

export interface WithdrawableAmountResponse {
  amounts: Coin[];
}

export async function getWithdrawableAmount(leaseUuid: string): Promise<Coin[]> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.billing.v1.withdrawableAmount({ leaseUuid }),
    null,
  );
  if (!data) return [];
  return (data.amounts ?? []) as unknown as Coin[];
}

export interface ProviderWithdrawableResponse {
  amounts: Coin[];
  lease_count: string;
  has_more: boolean;
}

export async function getProviderWithdrawable(providerUuid: string): Promise<ProviderWithdrawableResponse> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.billing.v1.providerWithdrawable({ providerUuid, limit: BigInt(0) }),
    null,
  );
  if (!data) return { amounts: [], lease_count: '0', has_more: false };
  return {
    amounts: (data.amounts ?? []) as unknown as Coin[],
    lease_count: String(data.lease_count),
    has_more: data.has_more,
  };
}

export async function getLeasesBySKU(skuUuid: string, stateFilter?: LeaseState): Promise<Lease[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.billing.v1.leasesBySKU({
    skuUuid,
    stateFilter: stateFilter ?? LeaseState.LEASE_STATE_UNSPECIFIED,
  });
  return parseLeases((data.leases ?? []) as unknown as RawLease[]);
}

export interface PaginatedLeasesResponse {
  leases: Lease[];
  pagination?: {
    next_key?: string;
    total?: string;
  };
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

  const pagination = data.pagination as unknown as PaginatedLeasesResponse['pagination'];

  return {
    leases: parseLeases((data.leases ?? []) as unknown as RawLease[]),
    pagination,
  };
}

export interface PaginatedCreditsResponse {
  credit_accounts: CreditAccount[];
  balances: Record<string, Coin[]>;
  pagination?: {
    next_key?: string;
    total?: string;
  };
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

  const creditAccounts: CreditAccount[] = ((data.credit_accounts ?? []) as unknown[]).map(parseCreditAccount);
  const pagination = data.pagination as unknown as PaginatedCreditsResponse['pagination'];

  // N+1 query: fetch balances from bank module (see function docs for rationale)
  const balances: Record<string, Coin[]> = {};

  if (creditAccounts.length > 0) {
    const balancePromises = creditAccounts.map(async (account) => {
      try {
        const balanceData = await client.cosmos.bank.v1beta1.allBalances({ address: account.credit_address, resolveDenom: false });
        return { key: account.credit_address, balances: (balanceData.balances ?? []) as unknown as Coin[] };
      } catch (error) {
        logError('billing.getAllCredits.fetchBalance', error);
        return { key: account.credit_address, balances: [] };
      }
    });

    const results = await Promise.all(balancePromises);
    for (const result of results) {
      balances[result.key] = result.balances;
    }
  }

  return {
    credit_accounts: creditAccounts,
    balances,
    pagination,
  };
}
