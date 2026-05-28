/**
 * Pure gating predicate for example-app deploy buttons in `ChatPanel`.
 *
 * Two layers of "disabled":
 *  1. Catalog-level — the SKU tier slice isn't ready (loading / idle / error).
 *     `notReadyTitle` is propagated (e.g. "Loading tier catalog…", "Deploy
 *     unavailable: <error>", or `undefined` for the disconnected case).
 *  2. Per-app — `app.size` is set but doesn't resolve in the current tier
 *     list. This catches the "old tier name baked into a stored example app
 *     manifest" case: the catalog itself loaded fine, but THIS specific
 *     button's tier hint is stale, so the button disables with a tier-
 *     specific tooltip.
 *
 * Returning `{ disabled: false, title: undefined }` is the green-light state.
 *
 * Extracted from JSX so the rendering surface stays declarative and the
 * gating logic can be unit-tested without a DOM render.
 */

import { resolveSizeName, type ResolvedSkuTier } from '../../api/skuTiers';

export interface ExampleAppGate {
  disabled: boolean;
  title?: string;
}

export interface ExampleAppGateInput {
  /** Stored size hint on the example-app entry. */
  size?: string;
  /** The resolved tier list from the AI store (`skuTiers.tiers`). */
  tiers: readonly ResolvedSkuTier[];
  /** Whether the SKU tier slice has reached `phase === 'ready'`. */
  tiersReady: boolean;
  /** Tooltip when the catalog itself isn't ready. */
  notReadyTitle?: string;
}

export function computeExampleAppGate(input: ExampleAppGateInput): ExampleAppGate {
  if (!input.tiersReady) {
    return { disabled: true, title: input.notReadyTitle };
  }
  if (input.size && resolveSizeName(input.size, input.tiers) === null) {
    return {
      disabled: true,
      title: `Tier '${input.size}' not available on this network.`,
    };
  }
  return { disabled: false };
}
