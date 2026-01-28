import { liftedinit } from '@manifest-network/manifestjs';

// API endpoints - use environment variables with localhost defaults for development
export const REST_URL = import.meta.env.PUBLIC_REST_URL || 'http://localhost:1317';
export const RPC_ENDPOINT = import.meta.env.PUBLIC_RPC_URL || 'http://localhost:26657';

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

// Import Unit directly from manifestjs to avoid circular dependency with sku.ts
const Unit = liftedinit.sku.v1.Unit;
type Unit = (typeof Unit)[keyof typeof Unit];

/**
 * Map unit enum to display label.
 * TypeScript enforces completeness - adding a new unit to manifestjs will cause a compile error.
 */
export const UNIT_LABELS: Record<Unit, string> = {
  [Unit.UNIT_UNSPECIFIED]: '',
  [Unit.UNIT_PER_HOUR]: '/hr',
  [Unit.UNIT_PER_DAY]: '/day',
  [Unit.UNRECOGNIZED]: '',
};

/**
 * Format a price amount with symbol and optional unit label.
 * @param amount - Raw amount string (in smallest unit, e.g., umfx)
 * @param denom - Denomination string
 * @param unit - Optional unit type
 * @returns Formatted price string like "1.5 MFX/hr" or "0 SYMBOL" for invalid amounts
 */
export function formatPrice(amount: string, denom: string, unit?: Unit): string {
  const meta = DENOM_METADATA[denom];
  const exponent = meta?.exponent ?? 6;
  const symbol = meta?.symbol ?? denom;
  const parsed = parseInt(amount, 10);
  if (Number.isNaN(parsed)) {
    return `0 ${symbol}`;
  }
  const value = parsed / Math.pow(10, exponent);
  const formatted = value.toLocaleString(undefined, { maximumFractionDigits: 6 });

  if (unit != null) {
    const unitLabel = UNIT_LABELS[unit] ?? '';
    return `${formatted} ${symbol}${unitLabel}`;
  }

  return `${formatted} ${symbol}`;
}
