/**
 * Resolved SKU tier list — joins the chain SKU catalog with env-provided specs
 * and normalizes pricing to per-hour display units.
 *
 * Chain is authoritative for which SKUs exist + their price. The env var
 * `PUBLIC_SKU_SPECS` is authoritative for the CPU/RAM/disk numbers. The
 * resolved list is the intersection of the two: any chain SKU without a spec
 * entry is dropped (with a console warning) so the UI never lies about
 * resources.
 */

import { getSKUs, Unit } from './sku';
import type { SKU } from './sku';
import { getDenomMetadata } from './config';
import { fromBaseUnits } from '../utils/format';
import { logError } from '../utils/errors';
import type { SkuSpecMap } from '../config/skuSpecs';

export interface ResolvedSkuTier {
  /** Full SKU name from chain (e.g., 'docker-micro'). Also the env-var key. */
  skuName: string;
  /** SKU UUID — used for transactions and provider resolution. */
  skuUuid: string;
  /** Provider UUID this SKU belongs to. */
  providerUuid: string;
  /** Specs from env. */
  cores: number;
  ramMB: number;
  diskGB: number;
  /** Normalized price per hour in display units (already divided by 10^exponent). */
  pricePerHour: number;
  /** Display denom symbol (e.g., 'PWR'). */
  denomSymbol: string;
  /** Raw chain Unit, preserved for the browse_catalog response. */
  unit: Unit;
}

export interface ResolveResult {
  tiers: ResolvedSkuTier[];
  /** First denom symbol seen across tiers — used as the global label. */
  denomSymbol: string;
}

/**
 * Resolve a user-supplied `size` argument to a `ResolvedSkuTier` (or `null`
 * if it doesn't match any tier in the current catalog).
 *
 * Match order, case-insensitive:
 *   1. Canonical SKU name match (`'docker-small'` → tier with that name)
 *   2. `docker-`-prefix backward-compat (`'small'` → `'docker-small'`)
 *   3. Suffix-only backward-compat (`'medium'` → `'gpu-medium'`)
 *
 * Used by both the executor (`compositeTransactions.ts` deploy paths) and
 * the UI gating layer (`ChatPanel.deployExample`, `AppsSidebar` re-deploy)
 * so a button that ships size hint `'small'` can only be enabled when the
 * executor will accept that same `'small'`.
 */
export function resolveSizeName(
  rawSize: string,
  tiers: readonly ResolvedSkuTier[],
): ResolvedSkuTier | null {
  const s = rawSize.trim().toLowerCase();
  const dockerS = `docker-${s}`;
  const dashS = `-${s}`;
  // Lowercase BOTH sides so a network shipping mixed-case SKU names
  // (e.g. 'Docker-Small') still matches a lowercase input. Computing
  // each tier's lowered name lazily inside the predicates keeps it
  // allocation-light for the common all-lowercase case.
  return (
    tiers.find((t) => t.skuName.toLowerCase() === s)
    ?? tiers.find((t) => t.skuName.toLowerCase() === dockerS)
    ?? tiers.find((t) => t.skuName.toLowerCase().endsWith(dashS))
    ?? null
  );
}

/**
 * Return the tier with the lowest normalized `pricePerHour`. Ties are
 * resolved by first occurrence in the input list. Throws on an empty list
 * — callers must guard `tiers.length === 0` themselves (typically with a
 * "Tier catalog unavailable" error).
 *
 * Used as the default size for `deploy_app` and `batch_deploy` when the
 * caller (or model) omits the `size` argument. Picking cheapest rather
 * than `tiers[0]` keeps the default sensible across networks whose env
 * spec map isn't ordered cheapest-first.
 */
export function getCheapestTier(tiers: readonly ResolvedSkuTier[]): ResolvedSkuTier {
  if (tiers.length === 0) {
    throw new Error('getCheapestTier called with empty tier list — caller must guard tiers.length === 0');
  }
  let cheapest = tiers[0];
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].pricePerHour < cheapest.pricePerHour) {
      cheapest = tiers[i];
    }
  }
  return cheapest;
}

export type SizeFallback = 'exact' | 'cheapest-omitted' | 'cheapest-unavailable';

export interface SizeResolution {
  tier: ResolvedSkuTier;
  fallback: SizeFallback;
  /** The raw requested size — present only for 'cheapest-unavailable'. */
  requested?: string;
}

/**
 * Resolve a size hint to a tier, falling back to the cheapest tier when the
 * hint is absent or doesn't match the current catalog. Returns null ONLY for
 * an empty tier list (the genuine "catalog unavailable" case). Shared by the
 * deploy executor (compositeTransactions.ts) and the ConfirmationCard so the
 * displayed price/specs always equal the tier that will deploy, and any
 * substitution is disclosed before the user approves.
 */
export function resolveSizeOrCheapest(
  rawSize: string | undefined,
  tiers: readonly ResolvedSkuTier[],
): SizeResolution | null {
  if (tiers.length === 0) return null;
  // Trim incidental whitespace and treat an empty-after-trim string as omitted,
  // so a whitespace-only size takes the unsurprising cheapest-omitted path
  // (no substitution note) and a padded valid size (e.g. ' docker-micro ')
  // still resolves exactly instead of falling back.
  const trimmed = rawSize?.trim();
  if (trimmed) {
    const match = resolveSizeName(trimmed, tiers);
    if (match) return { tier: match, fallback: 'exact' };
    return { tier: getCheapestTier(tiers), fallback: 'cheapest-unavailable', requested: trimmed };
  }
  return { tier: getCheapestTier(tiers), fallback: 'cheapest-omitted' };
}

/**
 * Human-readable one-line spec summary for a tier, e.g.
 * "0.5 vCPU · 512 MB RAM · 1 GB disk". Rendered on the ConfirmationCard so the
 * user sees the tier's capability (not just its price) before approving — this
 * is what neutralizes cheapest-tier under-provisioning surprise.
 */
export function formatTierSpecs(
  tier: Pick<ResolvedSkuTier, 'cores' | 'ramMB' | 'diskGB'>,
): string {
  let ram: string;
  if (tier.ramMB >= 1024) {
    const gb = tier.ramMB / 1024;
    ram = `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  } else {
    ram = `${tier.ramMB} MB`;
  }
  return `${tier.cores} vCPU · ${ram} RAM · ${tier.diskGB} GB disk`;
}

/**
 * Convert a SKU's basePrice + Unit to a per-hour price in display units.
 * - UNIT_PER_HOUR → basePrice as-is
 * - UNIT_PER_DAY  → basePrice / 24
 * - UNSPECIFIED / UNRECOGNIZED → treat as per-hour (default) and log
 * Returns 0 if basePrice is missing.
 */
export function hourlyPriceFromSku(sku: SKU): number {
  if (!sku.basePrice) return 0;
  const base = fromBaseUnits(sku.basePrice.amount, sku.basePrice.denom);
  switch (sku.unit) {
    case Unit.UNIT_PER_HOUR:
      return base;
    case Unit.UNIT_PER_DAY:
      return base / 24;
    default:
      logError(
        'skuTiers.hourlyPriceFromSku.unknownUnit',
        new Error(`SKU ${sku.uuid} has unrecognized unit ${sku.unit} — treating as per-hour`),
      );
      return base;
  }
}

/**
 * Fetch active SKUs from chain and join with env specs.
 * Throws on chain fetch failure (caller decides how to surface).
 */
export async function resolveSkuTiers(specs: SkuSpecMap): Promise<ResolveResult> {
  const skus = await getSKUs(true);  // activeOnly

  // Group SKUs by name. Multiple providers may offer the same SKU name at
  // different prices; collapsing to a single SKU per name (the old behavior)
  // silently picked whichever one chain returned last. Instead we keep the
  // full list per name so we can later pick the cheapest provider's offering.
  const skusByName = new Map<string, SKU[]>();
  for (const sku of skus) {
    const list = skusByName.get(sku.name);
    if (list) list.push(sku);
    else skusByName.set(sku.name, [sku]);
  }

  // Track which chain SKU instances were "consumed" by a resolved spec entry
  // so the unmatched-SKU warning loop doesn't fire for the losers of a
  // multi-provider tie (which are part of an already-matched name).
  const matchedSkuNames = new Set<string>();

  const tiers: ResolvedSkuTier[] = [];
  let denomSymbol = '';

  // Walk spec keys in insertion order so the resolved list has stable env-driven order.
  for (const [specName, spec] of Object.entries(specs)) {
    const candidates = skusByName.get(specName);
    if (!candidates || candidates.length === 0) {
      logError(
        'skuTiers.resolveSkuTiers.missingChainSku',
        new Error(`PUBLIC_SKU_SPECS includes "${specName}" but chain has no matching active SKU`),
      );
      continue;
    }

    // Filter out candidates that lack a basePrice — hourlyPriceFromSku
    // returns 0 for those, which would falsely beat every priced candidate
    // in the loop below and surface as a "free" tier. A genuinely-zero-price
    // tier has a basePrice object whose `amount === '0'`, so it survives
    // this filter and is selected correctly.
    const priced = candidates.filter((c) => !!c.basePrice);
    if (priced.length === 0) {
      // Claim the name so the missing-spec loop below doesn't log a second,
      // misleading warning ("Chain SKU 'X' has no entry in PUBLIC_SKU_SPECS")
      // about the same SKU. One root cause = one warning; the missing-spec
      // loop is for the genuinely-different "chain has it, spec doesn't" case.
      matchedSkuNames.add(specName);
      logError(
        'skuTiers.resolveSkuTiers.noPricedProvider',
        new Error(`PUBLIC_SKU_SPECS includes "${specName}" but no chain provider has a basePrice for it`),
      );
      continue;
    }

    // Pick the cheapest provider's SKU for this name; tie-break by first
    // occurrence (which mirrors the order chain returned them).
    let chosen = priced[0];
    let chosenPrice = hourlyPriceFromSku(chosen);
    for (let i = 1; i < priced.length; i++) {
      const p = hourlyPriceFromSku(priced[i]);
      if (p < chosenPrice) {
        chosen = priced[i];
        chosenPrice = p;
      }
    }

    matchedSkuNames.add(specName);
    const symbol = getDenomMetadata(chosen.basePrice?.denom ?? '').symbol;
    if (!denomSymbol) denomSymbol = symbol;
    tiers.push({
      skuName: chosen.name,
      skuUuid: chosen.uuid,
      providerUuid: chosen.providerUuid,
      cores: spec.cores,
      ramMB: spec.ramMB,
      diskGB: spec.diskGB,
      pricePerHour: chosenPrice,
      denomSymbol: symbol,
      unit: chosen.unit,
    });
  }

  // Warn (once per name) for chain SKUs whose name has no spec entry at all
  // — they get dropped. SKUs that lost a multi-provider tie under a matched
  // name are NOT "missing": the name is still represented, just by a
  // different provider's offering. We check `matchedSkuNames` so the warning
  // loop matches the per-name semantics. A `Set` of already-warned names
  // also stops us from logging once per duplicate chain row.
  const warnedNames = new Set<string>();
  for (const sku of skus) {
    if (matchedSkuNames.has(sku.name) || warnedNames.has(sku.name)) continue;
    warnedNames.add(sku.name);
    logError(
      'skuTiers.resolveSkuTiers.missingSpec',
      new Error(`Chain SKU "${sku.name}" has no entry in PUBLIC_SKU_SPECS — omitted from tier list`),
    );
  }

  return { tiers, denomSymbol };
}
