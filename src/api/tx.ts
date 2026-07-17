/**
 * Shared transaction-domain types for the Manifest billing module.
 *
 * ENG-312 Phase 7: the hand-rolled `SigningStargateClient` + `fundCredit`
 * broadcast path was deleted — credit funding now goes through the SDK's
 * `fundCredits(TxCtx)` (see `useAccountSetup`), and every other chain TX runs
 * through the SDK deploy/chain facades. This module is now just the shared
 * tx-domain type surface + the `Unit` re-export.
 */

// Re-export Unit from sku.ts (single source of truth) for consumers that
// import it from api/tx.
export { Unit } from './sku';

export interface LeaseItemInput {
  skuUuid: string;
  quantity: number;
}
