/**
 * Shared formatting utilities
 */

import { getDenomMetadata } from '../api/config';

// ============================================
// Amount Conversion Utilities
// ============================================

/**
 * Convert a display amount to base units (smallest denomination).
 * E.g., 1.5 MFX -> "1500000" umfx
 *
 * @param amount - Display amount (e.g., 1.5)
 * @param denom - Token denomination (e.g., "umfx" or DENOMS.MFX)
 * @returns Base unit amount as string, suitable for blockchain transactions
 */
export function toBaseUnits(amount: number, denom: string): string {
  if (!Number.isFinite(amount) || amount < 0) {
    return '0';
  }
  const { exponent } = getDenomMetadata(denom);
  // Round to the token's decimal precision first, then shift the decimal point
  // via string manipulation to avoid floating-point errors from multiplication.
  const fixed = amount.toFixed(exponent);
  const dotIndex = fixed.indexOf('.');
  if (dotIndex === -1) {
    return fixed + '0'.repeat(exponent);
  }
  const raw = fixed.slice(0, dotIndex) + fixed.slice(dotIndex + 1);
  // Strip leading zeros, preserving at least "0"
  return raw.replace(/^0+(?=\d)/, '');
}

/**
 * Convert base units to display amount.
 * E.g., "1500000" umfx -> 1.5 MFX
 *
 * @param amount - Base unit amount as string (e.g., "1500000")
 * @param denom - Token denomination (e.g., "umfx" or DENOMS.MFX)
 * @returns Display amount as number
 */
export function fromBaseUnits(amount: string, denom: string): number {
  const { exponent } = getDenomMetadata(denom);
  const parsed = parseInt(amount, 10);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return parsed / Math.pow(10, exponent);
}

/**
 * Parse a base unit amount string to number (without denomination conversion).
 * Useful for calculations that need the raw base unit value.
 *
 * @param amount - Base unit amount as string
 * @returns Parsed integer, or 0 if invalid
 */
export function parseBaseUnits(amount: string): number {
  const parsed = parseInt(amount, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// ============================================
// Formatting Utilities
// ============================================

/**
 * Format a timestamp as a short relative time string (e.g., "just now", "5m ago", "2h ago", "3d ago").
 * Accepts a raw numeric timestamp (Date.now()-style).
 */
export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format a byte count for display (e.g., "1.2 KB" or "512 B").
 */
export function formatFileSize(bytes: number): string {
  return bytes >= 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${bytes} B`;
}

/**
 * Parses a JSON string or value into an array of strings.
 * Returns an error message if validation fails, or the parsed array if valid.
 *
 * @param rawArgs - The raw arguments (string or array)
 * @returns Object with either `data` (string array) or `error` (error message)
 */
export function parseJsonStringArray(
  rawArgs: unknown
): { data: string[]; error?: never } | { data?: never; error: string } {
  // Only treat null/undefined as "no args"
  if (rawArgs == null) {
    return { data: [] };
  }

  // Reject other invalid types (number, boolean, etc.)
  if (typeof rawArgs !== 'string' && !Array.isArray(rawArgs)) {
    return { error: `Invalid args format: expected a JSON string or array, got ${typeof rawArgs}.` };
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
  } catch {
    return { error: 'Invalid args format: could not parse JSON. Use format: ["arg1", "arg2"]' };
  }

  if (!Array.isArray(parsedArgs)) {
    return { error: 'Invalid args format: must be a JSON array of strings.' };
  }

  for (let i = 0; i < parsedArgs.length; i++) {
    if (typeof parsedArgs[i] !== 'string') {
      return { error: `Invalid args format: element at index ${i} must be a string.` };
    }
  }

  return { data: parsedArgs as string[] };
}
