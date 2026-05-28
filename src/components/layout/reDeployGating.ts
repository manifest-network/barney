/**
 * Pure gating predicate for the per-app re-deploy button in `AppsSidebar`.
 *
 * Disable hierarchy (first match wins):
 *  1. SKU tier catalog not ready (`tiersReady === false`). Tooltip is
 *     `Tier catalog unavailable`. Mirrors the catalog-level gate the rest
 *     of the deploy surface uses.
 *  2. App has a stored `size` but it doesn't resolve in the current tier
 *     list (env spec changed, network swap, tier renamed upstream, …).
 *     Tooltip names the missing tier so the user can tell why their
 *     previously-working button just stopped working.
 *  3. Default — `{ disabled: false, title: 'Re-deploy' }`.
 *
 * Extracted so the rendering surface stays declarative and the gating
 * logic can be unit-tested without rendering the (cosmos-kit-heavy)
 * sidebar.
 */

import { resolveSizeName, type ResolvedSkuTier } from '../../api/skuTiers';

export interface ReDeployGate {
  disabled: boolean;
  title: string;
}

export interface ReDeployGateInput {
  /** Stored size from the registered app entry. */
  size?: string;
  /** The resolved tier list from the AI store (`skuTiers.tiers`). */
  tiers: readonly ResolvedSkuTier[];
  /** Whether the SKU tier slice has reached `phase === 'ready'`. */
  tiersReady: boolean;
}

export function computeReDeployGate(input: ReDeployGateInput): ReDeployGate {
  if (!input.tiersReady) {
    return { disabled: true, title: 'Tier catalog unavailable' };
  }
  if (input.size && resolveSizeName(input.size, input.tiers) === null) {
    return {
      disabled: true,
      title: `Original tier '${input.size}' is no longer available.`,
    };
  }
  return { disabled: false, title: 'Re-deploy' };
}
