import { REST_URL } from './config';
import type { Coin } from './bank';

export type LeaseState =
  | 'LEASE_STATE_UNSPECIFIED'
  | 'LEASE_STATE_PENDING'
  | 'LEASE_STATE_ACTIVE'
  | 'LEASE_STATE_CLOSED'
  | 'LEASE_STATE_REJECTED'
  | 'LEASE_STATE_EXPIRED';

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

export interface LeasesResponse {
  leases: Lease[];
}

export interface LeaseResponse {
  lease: Lease;
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
  const response = await fetch(`${REST_URL}/liftedinit/billing/v1/credit/${tenant}`);

  if (!response.ok) {
    if (response.status === 404) {
      // No credit account exists yet
      const creditAddress = await getCreditAddress(tenant);
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
    throw new Error(`Failed to fetch credit account: ${response.statusText}`);
  }

  return response.json();
}

export async function getCreditAddress(tenant: string): Promise<string> {
  const response = await fetch(`${REST_URL}/liftedinit/billing/v1/credit-address/${tenant}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch credit address: ${response.statusText}`);
  }

  const data: CreditAddressResponse = await response.json();
  return data.credit_address;
}

export async function getCreditEstimate(tenant: string): Promise<CreditEstimateResponse | null> {
  const response = await fetch(`${REST_URL}/liftedinit/billing/v1/credit/${tenant}/estimate`);

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch credit estimate: ${response.statusText}`);
  }

  return response.json();
}

export async function getBillingParams(): Promise<BillingParams> {
  const response = await fetch(`${REST_URL}/liftedinit/billing/v1/params`);

  if (!response.ok) {
    throw new Error(`Failed to fetch billing params: ${response.statusText}`);
  }

  const data: BillingParamsResponse = await response.json();
  return data.params;
}

export async function getLeasesByTenant(tenant: string, stateFilter?: LeaseState): Promise<Lease[]> {
  let url = `${REST_URL}/liftedinit/billing/v1/leases/tenant/${tenant}`;
  if (stateFilter && stateFilter !== 'LEASE_STATE_UNSPECIFIED') {
    url += `?state_filter=${stateFilter}`;
  }

  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error(`Failed to fetch leases: ${response.statusText}`);
  }

  const data: LeasesResponse = await response.json();
  return data.leases || [];
}

export async function getLeasesByProvider(providerUuid: string, stateFilter?: LeaseState): Promise<Lease[]> {
  let url = `${REST_URL}/liftedinit/billing/v1/leases/provider/${providerUuid}`;
  if (stateFilter && stateFilter !== 'LEASE_STATE_UNSPECIFIED') {
    url += `?state_filter=${stateFilter}`;
  }

  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error(`Failed to fetch leases: ${response.statusText}`);
  }

  const data: LeasesResponse = await response.json();
  return data.leases || [];
}

export async function getLease(leaseUuid: string): Promise<Lease | null> {
  const response = await fetch(`${REST_URL}/liftedinit/billing/v1/lease/${leaseUuid}`);

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Failed to fetch lease: ${response.statusText}`);
  }

  const data: LeaseResponse = await response.json();
  return data.lease;
}

export interface WithdrawableAmountResponse {
  amounts: Coin[];
}

export async function getWithdrawableAmount(leaseUuid: string): Promise<Coin[]> {
  const response = await fetch(`${REST_URL}/liftedinit/billing/v1/lease/${leaseUuid}/withdrawable`);

  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error(`Failed to fetch withdrawable amount: ${response.statusText}`);
  }

  const data: WithdrawableAmountResponse = await response.json();
  return data.amounts || [];
}

export interface ProviderWithdrawableResponse {
  amounts: Coin[];
  lease_count: string;
  has_more: boolean;
}

export async function getProviderWithdrawable(providerUuid: string): Promise<ProviderWithdrawableResponse> {
  const response = await fetch(`${REST_URL}/liftedinit/billing/v1/provider/${providerUuid}/withdrawable`);

  if (!response.ok) {
    if (response.status === 404) {
      return { amounts: [], lease_count: '0', has_more: false };
    }
    throw new Error(`Failed to fetch provider withdrawable: ${response.statusText}`);
  }

  return response.json();
}

export async function getLeasesBySKU(skuUuid: string, stateFilter?: LeaseState): Promise<Lease[]> {
  let url = `${REST_URL}/liftedinit/billing/v1/leases/sku/${skuUuid}`;
  if (stateFilter && stateFilter !== 'LEASE_STATE_UNSPECIFIED') {
    url += `?state_filter=${stateFilter}`;
  }

  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error(`Failed to fetch leases by SKU: ${response.statusText}`);
  }

  const data: LeasesResponse = await response.json();
  return data.leases || [];
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
  const searchParams = new URLSearchParams();

  if (params?.stateFilter && params.stateFilter !== 'LEASE_STATE_UNSPECIFIED') {
    searchParams.set('state_filter', params.stateFilter);
  }
  if (params?.limit) {
    searchParams.set('pagination.limit', String(params.limit));
  }
  if (params?.offset) {
    searchParams.set('pagination.offset', String(params.offset));
  }
  if (params?.paginationKey) {
    searchParams.set('pagination.key', params.paginationKey);
  }

  const queryString = searchParams.toString();
  const url = `${REST_URL}/liftedinit/billing/v1/leases${queryString ? `?${queryString}` : ''}`;

  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      return { leases: [] };
    }
    throw new Error(`Failed to fetch all leases: ${response.statusText}`);
  }

  return response.json();
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

export async function getAllCredits(params?: GetAllCreditsParams): Promise<PaginatedCreditsResponse> {
  const searchParams = new URLSearchParams();

  if (params?.limit) {
    searchParams.set('pagination.limit', String(params.limit));
  }
  if (params?.offset) {
    searchParams.set('pagination.offset', String(params.offset));
  }
  if (params?.paginationKey) {
    searchParams.set('pagination.key', params.paginationKey);
  }

  const queryString = searchParams.toString();
  const url = `${REST_URL}/liftedinit/billing/v1/credits${queryString ? `?${queryString}` : ''}`;

  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      return { credit_accounts: [], balances: {} };
    }
    throw new Error(`Failed to fetch all credits: ${response.statusText}`);
  }

  return response.json();
}
