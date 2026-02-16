import { liftedinit } from '@manifest-network/manifestjs';
import { runtimeConfig } from '../config/runtimeConfig';

// API endpoints - resolved at startup via runtimeConfig (runtime → env → defaults)
export const REST_URL = runtimeConfig.PUBLIC_REST_URL;
export const RPC_ENDPOINT = runtimeConfig.PUBLIC_RPC_URL;

export const DENOMS = {
  MFX: 'umfx',
  PWR: runtimeConfig.PUBLIC_PWR_DENOM,
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
 * Look up denomination metadata with a consistent fallback.
 * Uses the denom string itself as the symbol when unknown, with a default exponent of 6.
 */
export function getDenomMetadata(denom: string): { symbol: string; exponent: number } {
  return DENOM_METADATA[denom] ?? { symbol: denom, exponent: 6 };
}

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

