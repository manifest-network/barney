import { liftedinit } from '@manifest-network/manifestjs';
import { fetchJson, buildUrl, buildPaginationParams } from './utils';
import type { Coin } from './bank';

// Re-export LeaseState enum from manifestjs for type safety
export const LeaseState = liftedinit.billing.v1.LeaseState;
export type LeaseState = (typeof LeaseState)[keyof typeof LeaseState];

// Conversion functions from manifestjs
const { leaseStateFromJSON: fromJSON, leaseStateToJSON: toJSON } = liftedinit.billing.v1;

/**
 * Convert a lease state enum to its string representation.
 * Used for API URLs and HTML select option values.
 */
export function leaseStateToString(state: LeaseState): string {
  return toJSON(state);
}

/**
 * Convert a lease state string to enum value.
 * Used for parsing API responses and HTML select values.
 */
export function leaseStateFromString(state: string): LeaseState {
  return fromJSON(state);
}

/**
 * Mapping from user-friendly lease state names to enum values.
 * Used by AI tools to convert user input to API format.
 */
export const LEASE_STATE_MAP: Record<string, LeaseState> = {
  pending: LeaseState.LEASE_STATE_PENDING,
  active: LeaseState.LEASE_STATE_ACTIVE,
  closed: LeaseState.LEASE_STATE_CLOSED,
  rejected: LeaseState.LEASE_STATE_REJECTED,
  expired: LeaseState.LEASE_STATE_EXPIRED,
};

/**
 * Valid user-friendly lease state filter values (includes 'all' for no filter)
 */
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
  closed_at?: string;
  acknowledged_at?: string;
  rejected_at?: string;
  expired_at?: string;
  rejection_reason?: string;
  closure_reason?: string;
  min_lease_duration_at_creation?: string;
  meta_hash?: string;
}

/**
 * Raw lease response from API (state is a string)
 */
interface RawLease extends Omit<Lease, 'state'> {
  state: string;
}

/**
 * Convert a raw API lease response to a typed Lease with enum state.
 */
function parseLease(raw: RawLease): Lease {
  return {
    ...raw,
    state: fromJSON(raw.state),
  };
}

/**
 * Convert an array of raw API leases to typed Leases.
 */
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

export async function getCreditAccount(tenant: string): Promise<CreditAccountResponse> {
  // First try to get the credit address (this always works even if no account exists)
  const creditAddress = await getCreditAddress(tenant);

  // Then try to get the full account, using empty defaults if 404
  const data = await fetchJson<CreditAccountResponse | null>(
    `/liftedinit/billing/v1/credit/${tenant}`,
    'credit account',
    { notFoundDefault: null }
  );

  if (data) {
    return data;
  }

  // No credit account exists yet - return placeholder
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
  const data = await fetchJson<CreditAddressResponse>(
    `/liftedinit/billing/v1/credit-address/${tenant}`,
    'credit address'
  );
  return data.credit_address;
}

export async function getCreditEstimate(tenant: string): Promise<CreditEstimateResponse | null> {
  return fetchJson<CreditEstimateResponse | null>(
    `/liftedinit/billing/v1/credit/${tenant}/estimate`,
    'credit estimate',
    { notFoundDefault: null }
  );
}

export async function getBillingParams(): Promise<BillingParams> {
  const data = await fetchJson<BillingParamsResponse>(
    '/liftedinit/billing/v1/params',
    'billing params'
  );
  return data.params;
}

export async function getLeasesByTenant(tenant: string, stateFilter?: LeaseState): Promise<Lease[]> {
  const params: Record<string, string | undefined> = {};
  if (stateFilter != null && stateFilter !== LeaseState.LEASE_STATE_UNSPECIFIED) {
    params.state_filter = leaseStateToString(stateFilter);
  }

  const url = buildUrl(`/liftedinit/billing/v1/leases/tenant/${tenant}`, params);
  const data = await fetchJson<{ leases?: RawLease[] }>(url, 'leases', { notFoundDefault: { leases: [] } });
  return parseLeases(data.leases ?? []);
}

export async function getLeasesByProvider(providerUuid: string, stateFilter?: LeaseState): Promise<Lease[]> {
  const params: Record<string, string | undefined> = {};
  if (stateFilter != null && stateFilter !== LeaseState.LEASE_STATE_UNSPECIFIED) {
    params.state_filter = leaseStateToString(stateFilter);
  }

  const url = buildUrl(`/liftedinit/billing/v1/leases/provider/${providerUuid}`, params);
  const data = await fetchJson<{ leases?: RawLease[] }>(url, 'leases', { notFoundDefault: { leases: [] } });
  return parseLeases(data.leases ?? []);
}

export async function getLease(leaseUuid: string): Promise<Lease | null> {
  const data = await fetchJson<{ lease?: RawLease }>(
    `/liftedinit/billing/v1/lease/${leaseUuid}`,
    'lease',
    { notFoundDefault: {} }
  );
  return data.lease ? parseLease(data.lease) : null;
}

export interface WithdrawableAmountResponse {
  amounts: Coin[];
}

export async function getWithdrawableAmount(leaseUuid: string): Promise<Coin[]> {
  const data = await fetchJson<WithdrawableAmountResponse>(
    `/liftedinit/billing/v1/lease/${leaseUuid}/withdrawable`,
    'withdrawable amount',
    { notFoundDefault: { amounts: [] } }
  );
  return data.amounts ?? [];
}

export interface ProviderWithdrawableResponse {
  amounts: Coin[];
  lease_count: string;
  has_more: boolean;
}

export async function getProviderWithdrawable(providerUuid: string): Promise<ProviderWithdrawableResponse> {
  return fetchJson<ProviderWithdrawableResponse>(
    `/liftedinit/billing/v1/provider/${providerUuid}/withdrawable`,
    'provider withdrawable',
    { notFoundDefault: { amounts: [], lease_count: '0', has_more: false } }
  );
}

export async function getLeasesBySKU(skuUuid: string, stateFilter?: LeaseState): Promise<Lease[]> {
  const params: Record<string, string | undefined> = {};
  if (stateFilter != null && stateFilter !== LeaseState.LEASE_STATE_UNSPECIFIED) {
    params.state_filter = leaseStateToString(stateFilter);
  }

  const url = buildUrl(`/liftedinit/billing/v1/leases/sku/${skuUuid}`, params);
  const data = await fetchJson<{ leases?: RawLease[] }>(url, 'leases by SKU', { notFoundDefault: { leases: [] } });
  return parseLeases(data.leases ?? []);
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

export async function getAllLeases(params?: GetAllLeasesParams): Promise<PaginatedLeasesResponse> {
  const queryParams: Record<string, string | undefined> = {
    ...buildPaginationParams({
      limit: params?.limit,
      offset: params?.offset,
      paginationKey: params?.paginationKey,
      countTotal: !!params?.limit,
    }),
  };

  if (params?.stateFilter != null && params.stateFilter !== LeaseState.LEASE_STATE_UNSPECIFIED) {
    queryParams.state_filter = leaseStateToString(params.stateFilter);
  }

  const url = buildUrl('/liftedinit/billing/v1/leases', queryParams);
  const data = await fetchJson<{ leases?: RawLease[]; pagination?: PaginatedLeasesResponse['pagination'] }>(
    url,
    'all leases',
    { notFoundDefault: { leases: [] } }
  );

  return {
    ...data,
    leases: parseLeases(data.leases ?? []),
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
 *
 * **Future improvements if needed:**
 * - Request throttling/batching for larger page sizes
 * - Backend API enhancement to include balances in bulk response
 * - Caching layer for balance data
 */
export async function getAllCredits(params?: GetAllCreditsParams): Promise<PaginatedCreditsResponse> {
  const queryParams = buildPaginationParams({
    limit: params?.limit,
    offset: params?.offset,
    paginationKey: params?.paginationKey,
    countTotal: !!params?.limit,
  });

  const url = buildUrl('/liftedinit/billing/v1/credits', queryParams);
  const data = await fetchJson<{ credit_accounts?: CreditAccount[]; pagination?: PaginatedCreditsResponse['pagination'] }>(
    url,
    'all credits',
    { notFoundDefault: { credit_accounts: [] } }
  );

  const creditAccounts: CreditAccount[] = data.credit_accounts ?? [];

  // N+1 query: fetch balances from bank module (see function docs for rationale)
  const balances: Record<string, Coin[]> = {};

  if (creditAccounts.length > 0) {
    const balancePromises = creditAccounts.map(async (account) => {
      try {
        const balanceData = await fetchJson<{ balances?: Coin[] }>(
          `/cosmos/bank/v1beta1/balances/${account.credit_address}`,
          'balance'
        );
        return { key: account.credit_address, balances: balanceData.balances ?? [] };
      } catch {
        // Balance fetch failures are non-critical; return empty balance
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
    pagination: data.pagination,
  };
}
