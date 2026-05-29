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
import type { SkuTiersPhase } from '../../stores/aiActions/skuTiers';

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

/**
 * Sister of `computeExampleAppGate` for the typed-command path (e.g.
 * "deploy tetris" routed through `doSubmit` → `deployExample`).
 *
 * The button-click path can lean on tooltips to explain a disabled state.
 * The typed path has no tooltip surface — `doSubmit` has already cleared
 * the input by the time `deployExample` runs, so a silent `return` from
 * `deployExample` looks like the app froze (empty input + zero feedback).
 *
 * Returns the chat message to surface via `addLocalMessage` when the
 * deploy should be rejected, or `null` when the deploy should proceed.
 * Same gating hierarchy as `computeExampleAppGate`: catalog readiness
 * wins first, then per-app size resolution.
 */
export interface DeployExampleRejectionInput {
  size?: string;
  tiers: readonly ResolvedSkuTier[];
  tiersReady: boolean;
  /** Current SKU tiers slice phase — needed to pick loading-vs-error wording. */
  phase: SkuTiersPhase;
  /** `skuTiers.error` from the store, only meaningful when `phase === 'error'`. */
  errorMessage: string | null;
}

export function getDeployExampleRejection(input: DeployExampleRejectionInput): string | null {
  if (!input.tiersReady) {
    if (input.phase === 'error') {
      // No "Click Retry above" — the rejection is rendered through
      // MessageBubble's inline-alert path which attaches its own Retry
      // suggestion button next to the error text via ERROR_PATTERNS.
      // Referencing a separate control was a footgun on cold-load paths
      // where showExampleApps gating hides the banner the prose pointed at.
      return `Deploy unavailable: ${input.errorMessage ?? 'tier catalog not ready'}.`;
    }
    return 'Deploy unavailable: tier catalog is still loading. Please wait a moment and try again.';
  }
  if (input.size && resolveSizeName(input.size, input.tiers) === null) {
    return `Tier '${input.size}' is not available on this network.`;
  }
  return null;
}
