import type { Provider, SKU, Lease, CreditAccount, CreditEstimate } from './types';

export const mockProviders: Provider[] = [
  {
    uuid: '0194d8a0-0001-7000-8000-000000000001',
    address: 'manifest1provider1address',
    payoutAddress: 'manifest1provider1payout',
    metaHash: 'QmProvider1MetaHash',
    active: true,
    apiUrl: 'https://provider1.example.com/api',
  },
  {
    uuid: '0194d8a0-0002-7000-8000-000000000002',
    address: 'manifest1provider2address',
    payoutAddress: 'manifest1provider2payout',
    metaHash: 'QmProvider2MetaHash',
    active: true,
    apiUrl: 'https://provider2.example.com/api',
  },
  {
    uuid: '0194d8a0-0003-7000-8000-000000000003',
    address: 'manifest1provider3address',
    payoutAddress: 'manifest1provider3payout',
    metaHash: 'QmProvider3MetaHash',
    active: false,
    apiUrl: 'https://provider3.example.com/api',
  },
];

export const mockSKUs: SKU[] = [
  {
    uuid: '0194d8b0-0001-7000-8000-000000000001',
    providerUuid: '0194d8a0-0001-7000-8000-000000000001',
    name: 'Small VM',
    unit: 'UNIT_PER_HOUR',
    basePrice: { denom: 'umfx', amount: '1000' },
    metaHash: 'QmSKU1MetaHash',
    active: true,
  },
  {
    uuid: '0194d8b0-0002-7000-8000-000000000002',
    providerUuid: '0194d8a0-0001-7000-8000-000000000001',
    name: 'Medium VM',
    unit: 'UNIT_PER_HOUR',
    basePrice: { denom: 'umfx', amount: '2500' },
    metaHash: 'QmSKU2MetaHash',
    active: true,
  },
  {
    uuid: '0194d8b0-0003-7000-8000-000000000003',
    providerUuid: '0194d8a0-0001-7000-8000-000000000001',
    name: 'Large VM',
    unit: 'UNIT_PER_HOUR',
    basePrice: { denom: 'umfx', amount: '5000' },
    metaHash: 'QmSKU3MetaHash',
    active: true,
  },
  {
    uuid: '0194d8b0-0004-7000-8000-000000000004',
    providerUuid: '0194d8a0-0002-7000-8000-000000000002',
    name: 'Storage 100GB',
    unit: 'UNIT_PER_DAY',
    basePrice: { denom: 'umfx', amount: '500' },
    metaHash: 'QmSKU4MetaHash',
    active: true,
  },
  {
    uuid: '0194d8b0-0005-7000-8000-000000000005',
    providerUuid: '0194d8a0-0002-7000-8000-000000000002',
    name: 'Storage 500GB',
    unit: 'UNIT_PER_DAY',
    basePrice: { denom: 'umfx', amount: '2000' },
    metaHash: 'QmSKU5MetaHash',
    active: true,
  },
  {
    uuid: '0194d8b0-0006-7000-8000-000000000006',
    providerUuid: '0194d8a0-0001-7000-8000-000000000001',
    name: 'Deprecated VM',
    unit: 'UNIT_PER_HOUR',
    basePrice: { denom: 'umfx', amount: '800' },
    metaHash: 'QmSKU6MetaHash',
    active: false,
  },
];

export const mockLeases: Lease[] = [
  {
    uuid: '0194d8c0-0001-7000-8000-000000000001',
    tenant: 'manifest1tenantaddress',
    providerUuid: '0194d8a0-0001-7000-8000-000000000001',
    items: [
      { skuUuid: '0194d8b0-0001-7000-8000-000000000001', quantity: 2, lockedPrice: { denom: 'umfx', amount: '278' } },
    ],
    state: 'LEASE_STATE_ACTIVE',
    createdAt: '2026-01-15T10:00:00Z',
    acknowledgedAt: '2026-01-15T10:05:00Z',
    lastSettledAt: '2026-01-19T08:00:00Z',
  },
  {
    uuid: '0194d8c0-0002-7000-8000-000000000002',
    tenant: 'manifest1tenantaddress',
    providerUuid: '0194d8a0-0001-7000-8000-000000000001',
    items: [
      { skuUuid: '0194d8b0-0002-7000-8000-000000000002', quantity: 1, lockedPrice: { denom: 'umfx', amount: '694' } },
    ],
    state: 'LEASE_STATE_PENDING',
    createdAt: '2026-01-19T12:00:00Z',
  },
  {
    uuid: '0194d8c0-0003-7000-8000-000000000003',
    tenant: 'manifest1tenantaddress',
    providerUuid: '0194d8a0-0002-7000-8000-000000000002',
    items: [
      { skuUuid: '0194d8b0-0004-7000-8000-000000000004', quantity: 5, lockedPrice: { denom: 'umfx', amount: '6' } },
    ],
    state: 'LEASE_STATE_CLOSED',
    createdAt: '2026-01-10T08:00:00Z',
    acknowledgedAt: '2026-01-10T08:10:00Z',
    closedAt: '2026-01-18T16:00:00Z',
  },
  {
    uuid: '0194d8c0-0004-7000-8000-000000000004',
    tenant: 'manifest1othertenantaddress',
    providerUuid: '0194d8a0-0001-7000-8000-000000000001',
    items: [
      { skuUuid: '0194d8b0-0003-7000-8000-000000000003', quantity: 1, lockedPrice: { denom: 'umfx', amount: '1389' } },
    ],
    state: 'LEASE_STATE_PENDING',
    createdAt: '2026-01-19T14:00:00Z',
  },
  {
    uuid: '0194d8c0-0005-7000-8000-000000000005',
    tenant: 'manifest1othertenantaddress',
    providerUuid: '0194d8a0-0001-7000-8000-000000000001',
    items: [
      { skuUuid: '0194d8b0-0001-7000-8000-000000000001', quantity: 3, lockedPrice: { denom: 'umfx', amount: '278' } },
    ],
    state: 'LEASE_STATE_ACTIVE',
    createdAt: '2026-01-12T09:00:00Z',
    acknowledgedAt: '2026-01-12T09:02:00Z',
    lastSettledAt: '2026-01-19T06:00:00Z',
  },
];

export const mockCreditAccount: CreditAccount = {
  tenant: 'manifest1tenantaddress',
  creditAddress: 'manifest1creditaddressderived',
  activeleaseCount: 1,
  pendingLeaseCount: 1,
  balance: { denom: 'umfx', amount: '50000000' },
};

export const mockCreditEstimate: CreditEstimate = {
  remainingSeconds: 86400 * 7, // ~7 days
  burnRatePerSecond: { denom: 'umfx', amount: '556' },
};

export const mockWalletAddress = 'manifest1tenantaddress';
export const mockWalletBalance = { denom: 'umfx', amount: '100000000' };
