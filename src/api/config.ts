export const REST_URL = 'http://localhost:1317';

export const DENOMS = {
  MFX: 'umfx',
  PWR: 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr',
} as const;

export const DENOM_METADATA: Record<string, { symbol: string; exponent: number }> = {
  [DENOMS.MFX]: {
    symbol: 'MFX',
    exponent: 6,
  },
  [DENOMS.PWR]: {
    symbol: 'PWR',
    exponent: 6,
  },
  // Alias for short denom form
  upwr: {
    symbol: 'PWR',
    exponent: 6,
  },
};

/**
 * Format a price amount with symbol and optional unit label.
 * @param amount - Raw amount string (in smallest unit, e.g., umfx)
 * @param denom - Denomination string
 * @param unit - Optional unit type ('UNIT_PER_HOUR' | 'UNIT_PER_DAY')
 * @returns Formatted price string like "1.5 MFX/hr"
 */
export function formatPrice(amount: string, denom: string, unit?: string): string {
  const meta = DENOM_METADATA[denom];
  const exponent = meta?.exponent ?? 6;
  const symbol = meta?.symbol ?? denom;
  const value = parseInt(amount, 10) / Math.pow(10, exponent);
  const formatted = value.toLocaleString(undefined, { maximumFractionDigits: 6 });

  if (unit) {
    const unitLabel = unit === 'UNIT_PER_HOUR' ? '/hr' : '/day';
    return `${formatted} ${symbol}${unitLabel}`;
  }

  return `${formatted} ${symbol}`;
}
