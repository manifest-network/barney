import { DENOM_METADATA, UNIT_LABELS } from '../api/config';
import { Unit } from '../api/sku';
import type { SKU } from '../api/sku';
import type { LeaseItemInput } from '../api/tx';

/**
 * Validates that a lease item has a valid SKU and positive integer quantity.
 */
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
  let total = 0;
  let denom = '';
  let unit: Unit = Unit.UNIT_UNSPECIFIED;

  for (const item of items) {
    if (item.skuUuid) {
      const sku = skus.find((s) => s.uuid === item.skuUuid);
      if (sku) {
        denom = sku.base_price.denom;
        unit = sku.unit;
        const price = Number(sku.base_price.amount);
        if (!Number.isSafeInteger(price) && import.meta.env.DEV) {
          console.warn(`[calculateEstimatedCost] Price exceeds safe integer range: ${sku.base_price.amount}`);
        }
        total += price * item.quantity;
      }
    }
  }

  if (total === 0) return null;

  const meta = DENOM_METADATA[denom] || { symbol: denom, exponent: 6 };
  const value = total / Math.pow(10, meta.exponent);
  const unitLabel = UNIT_LABELS[unit] ?? '';
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${meta.symbol}${unitLabel}`;
}
