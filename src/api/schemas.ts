/**
 * Zod schemas for API response validation.
 * These schemas validate data from external APIs to ensure type safety at runtime.
 */

import { z } from 'zod';

// ============================================
// Common Schemas
// ============================================

/** Cosmos SDK Coin schema */
export const CoinSchema = z.object({
  denom: z.string(),
  amount: z.string(),
});

/** Pagination response schema (nullable fields from API) */
export const PaginationSchema = z.object({
  next_key: z.string().nullish(),
  total: z.string().nullish(),
});

// ============================================
// Bank Module Schemas
// ============================================

export const BalanceResponseSchema = z.object({
  balance: CoinSchema.optional(),
});

export const AllBalancesResponseSchema = z.object({
  balances: z.array(CoinSchema).optional(),
});

// ============================================
// SKU Module Schemas
// ============================================

export const ProviderSchema = z.object({
  uuid: z.string(),
  address: z.string(),
  payout_address: z.string(),
  meta_hash: z.string().nullish(),
  active: z.boolean(),
  api_url: z.string(),
});

export const RawSKUSchema = z.object({
  uuid: z.string(),
  provider_uuid: z.string(),
  name: z.string(),
  unit: z.string(),
  base_price: CoinSchema,
  meta_hash: z.string().nullish(),
  active: z.boolean(),
});

export const ProvidersResponseSchema = z.object({
  providers: z.array(ProviderSchema).optional(),
});

export const ProviderResponseSchema = z.object({
  provider: ProviderSchema.optional(),
});

export const SKUsResponseSchema = z.object({
  skus: z.array(RawSKUSchema).optional(),
});

export const SKUResponseSchema = z.object({
  sku: RawSKUSchema.optional(),
});

export const SKUParamsSchema = z.object({
  allowed_list: z.array(z.string()),
});

export const SKUParamsResponseSchema = z.object({
  params: SKUParamsSchema,
});

// ============================================
// Billing Module Schemas
// ============================================

export const LeaseItemSchema = z.object({
  sku_uuid: z.string(),
  quantity: z.string(),
  locked_price: CoinSchema,
});

export const RawLeaseSchema = z.object({
  uuid: z.string(),
  tenant: z.string(),
  provider_uuid: z.string(),
  items: z.array(LeaseItemSchema),
  state: z.string(),
  created_at: z.string(),
  last_settled_at: z.string(),
  closed_at: z.string().nullish(),
  acknowledged_at: z.string().nullish(),
  rejected_at: z.string().nullish(),
  expired_at: z.string().nullish(),
  rejection_reason: z.string().nullish(),
  closure_reason: z.string().nullish(),
  min_lease_duration_at_creation: z.string().nullish(),
  meta_hash: z.string().nullish(),
});

export const LeasesResponseSchema = z.object({
  leases: z.array(RawLeaseSchema).optional(),
  pagination: PaginationSchema.optional(),
});

export const LeaseResponseSchema = z.object({
  lease: RawLeaseSchema.optional(),
});

export const BillingParamsSchema = z.object({
  max_leases_per_tenant: z.string(),
  allowed_list: z.array(z.string()),
  max_items_per_lease: z.string(),
  min_lease_duration: z.string(),
  max_pending_leases_per_tenant: z.string(),
  pending_timeout: z.string(),
});

export const BillingParamsResponseSchema = z.object({
  params: BillingParamsSchema,
});

export const CreditAccountSchema = z.object({
  tenant: z.string(),
  credit_address: z.string(),
  active_lease_count: z.coerce.number(),
  pending_lease_count: z.coerce.number(),
});

export const CreditAccountResponseSchema = z.object({
  credit_account: CreditAccountSchema,
  balances: z.array(CoinSchema),
});

export const CreditAddressResponseSchema = z.object({
  credit_address: z.string(),
});

export const CreditEstimateResponseSchema = z.object({
  current_balance: z.array(CoinSchema),
  total_rate_per_second: z.array(CoinSchema),
  estimated_duration_seconds: z.string(),
  active_lease_count: z.string(),
});

export const WithdrawableAmountResponseSchema = z.object({
  amounts: z.array(CoinSchema).optional(),
});

export const ProviderWithdrawableResponseSchema = z.object({
  amounts: z.array(CoinSchema).optional(),
  lease_count: z.string(),
  has_more: z.boolean(),
});

export const CreditsResponseSchema = z.object({
  credit_accounts: z.array(CreditAccountSchema).optional(),
  pagination: PaginationSchema.optional(),
});

// ============================================
// Type exports (inferred from schemas)
// ============================================

export type CoinValidated = z.infer<typeof CoinSchema>;
export type ProviderValidated = z.infer<typeof ProviderSchema>;
export type RawSKUValidated = z.infer<typeof RawSKUSchema>;
export type RawLeaseValidated = z.infer<typeof RawLeaseSchema>;
export type CreditAccountValidated = z.infer<typeof CreditAccountSchema>;
