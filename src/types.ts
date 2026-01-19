export type Unit = 'UNIT_PER_HOUR' | 'UNIT_PER_DAY';

export interface Provider {
  uuid: string;
  address: string;
  payoutAddress: string;
  metaHash: string;
  active: boolean;
  apiUrl: string;
}

export interface SKU {
  uuid: string;
  providerUuid: string;
  name: string;
  unit: Unit;
  basePrice: { denom: string; amount: string };
  metaHash: string;
  active: boolean;
}

export type LeaseState =
  | 'LEASE_STATE_PENDING'
  | 'LEASE_STATE_ACTIVE'
  | 'LEASE_STATE_CLOSED'
  | 'LEASE_STATE_REJECTED'
  | 'LEASE_STATE_EXPIRED';

export interface LeaseItem {
  skuUuid: string;
  quantity: number;
  lockedPrice: { denom: string; amount: string };
}

export interface Lease {
  uuid: string;
  tenant: string;
  providerUuid: string;
  items: LeaseItem[];
  state: LeaseState;
  createdAt: string;
  closedAt?: string;
  lastSettledAt?: string;
  acknowledgedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  expiredAt?: string;
}

export interface CreditAccount {
  tenant: string;
  creditAddress: string;
  activeleaseCount: number;
  pendingLeaseCount: number;
  balance: { denom: string; amount: string };
}

export interface CreditEstimate {
  remainingSeconds: number;
  burnRatePerSecond: { denom: string; amount: string };
}
