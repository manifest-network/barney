import { DENOM_METADATA, UNIT_LABELS } from '../api/config';
import type { LeaseItem } from '../api/billing';
import { Unit } from '../api/sku';
import type { SKU } from '../api/sku';
import type { LeaseItemInput } from '../api/tx';
import { SECONDS_PER_HOUR } from '../config/constants';
import { parseBaseUnits, fromBaseUnits } from './format';

/**
 * Validates that a lease item has a valid SKU and positive integer quantity.
 */
/**
 * Format the total cost per hour for a set of lease items.
 * Uses BigInt for intermediate calculations to avoid integer overflow.
 *
 * @param items - Lease items with locked per-second prices and quantities
 * @returns Formatted string (e.g., "0.0360 PWR/hr")
 */
export function formatCostPerHour(items: readonly LeaseItem[]): string {
  let total = 0n;
  for (const item of items) {
    const perSecond = BigInt(parseBaseUnits(item.locked_price.amount));
    const quantity = BigInt(parseInt(item.quantity, 10) || 0);
    total += perSecond * quantity * BigInt(SECONDS_PER_HOUR);
  }
  const denom = items[0]?.locked_price.denom;
  const meta = denom ? DENOM_METADATA[denom] || { symbol: 'tokens', exponent: 6 } : { symbol: 'tokens', exponent: 6 };
  return `${(Number(total) / Math.pow(10, meta.exponent)).toFixed(4)} ${meta.symbol}/hr`;
}

export function isValidLeaseItem(item: Pick<LeaseItemInput, 'skuUuid' | 'quantity'>): boolean {
  return Boolean(item.skuUuid) && Number.isInteger(item.quantity) && item.quantity > 0;
}

/**
 * Calculate the estimated cost for a set of lease items based on SKU prices.
 *
 * Note: This function assumes all selected SKUs use the same denomination and unit,
 * which is typically true for SKUs from the same provider. If SKUs with different
 * denoms/units are mixed, the result uses the last SKU's denom/unit for display.
 *
 * @param items - Array of lease items with SKU UUIDs and quantities
 * @param skus - Array of available SKUs to look up prices
 * @returns Formatted cost string (e.g., "1.5 PWR/hr") or null if no valid items
 */
export function calculateEstimatedCost(
  items: ReadonlyArray<Pick<LeaseItemInput, 'skuUuid' | 'quantity'>>,
  skus: readonly SKU[]
): string | null {
  let total = 0n;
  let denom = '';
  let unit: Unit = Unit.UNIT_UNSPECIFIED;

  for (const item of items) {
    if (item.skuUuid) {
      const sku = skus.find((s) => s.uuid === item.skuUuid);
      if (sku) {
        const price = parseBaseUnits(sku.base_price.amount);
        if (price === 0 && sku.base_price.amount !== '0') {
          // Skip items with invalid price data (parseBaseUnits returns 0 for invalid)
          continue;
        }
        denom = sku.base_price.denom;
        unit = sku.unit;
        total += BigInt(price) * BigInt(item.quantity);
      }
    }
  }

  if (total === 0n) return null;

  const meta = DENOM_METADATA[denom] || { symbol: denom, exponent: 6 };
  const value = fromBaseUnits(String(total), denom);
  const unitLabel = UNIT_LABELS[unit] ?? '';
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${meta.symbol}${unitLabel}`;
}
