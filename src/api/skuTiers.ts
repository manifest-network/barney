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

  // Index chain SKUs by name for spec-driven ordering.
  const skusByName = new Map<string, SKU>();
  for (const sku of skus) skusByName.set(sku.name, sku);

  const tiers: ResolvedSkuTier[] = [];
  const seenSpecs = new Set<string>();
  let denomSymbol = '';

  // Walk spec keys in insertion order so the resolved list has stable env-driven order.
  for (const [specName, spec] of Object.entries(specs)) {
    const sku = skusByName.get(specName);
    if (!sku) {
      logError(
        'skuTiers.resolveSkuTiers.missingChainSku',
        new Error(`PUBLIC_SKU_SPECS includes "${specName}" but chain has no matching active SKU`),
      );
      continue;
    }
    seenSpecs.add(specName);
    const symbol = getDenomMetadata(sku.basePrice?.denom ?? '').symbol;
    if (!denomSymbol) denomSymbol = symbol;
    tiers.push({
      skuName: sku.name,
      skuUuid: sku.uuid,
      providerUuid: sku.providerUuid,
      cores: spec.cores,
      ramMB: spec.ramMB,
      diskGB: spec.diskGB,
      pricePerHour: hourlyPriceFromSku(sku),
      denomSymbol: symbol,
      unit: sku.unit,
    });
  }

  // Warn for chain SKUs that exist but have no spec entry — they get dropped.
  for (const sku of skus) {
    if (!seenSpecs.has(sku.name)) {
      logError(
        'skuTiers.resolveSkuTiers.missingSpec',
        new Error(`Chain SKU "${sku.name}" has no entry in PUBLIC_SKU_SPECS — omitted from tier list`),
      );
    }
  }

  return { tiers, denomSymbol };
}
