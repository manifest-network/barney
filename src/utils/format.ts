/**
 * Shared formatting utilities
 */

import { DENOM_METADATA } from '../api/config';

/**
 * Format a token amount with proper decimals and symbol.
 *
 * @param amount - The raw amount as a string (in base units)
 * @param denom - The token denomination
 * @param maxDecimals - Maximum fraction digits to display (default: 6)
 * @returns Formatted string like "1,234.56 MFX" or "0 DENOM" for invalid amounts
 */
export function formatAmount(amount: string, denom: string, maxDecimals = 6): string {
  const metadata = DENOM_METADATA[denom as keyof typeof DENOM_METADATA];
  const exponent = metadata?.exponent ?? 6;
  const symbol = metadata?.symbol ?? denom;
  const parsed = parseInt(amount, 10);
  if (Number.isNaN(parsed)) {
    return `0 ${symbol}`;
  }
  const num = parsed / Math.pow(10, exponent);
  return `${num.toLocaleString(undefined, { maximumFractionDigits: maxDecimals })} ${symbol}`;
}

/**
 * Format a date string for display.
 * Handles null/empty dates, invalid dates, and the Go zero time.
 *
 * @param dateStr - ISO date string or undefined
 * @param options - 'datetime' for full datetime, 'date' for date only (default: 'datetime')
 * @returns Formatted date string or '-' for invalid/empty dates
 */
export function formatDate(dateStr: string | undefined, options: 'datetime' | 'date' = 'datetime'): string {
  if (!dateStr || dateStr === '0001-01-01T00:00:00Z') {
    return '-';
  }
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return options === 'date' ? date.toLocaleDateString() : date.toLocaleString();
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
 * UUID validation regex pattern
 * Matches standard UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates if a string is a valid UUID format
 */
export function isValidUUID(uuid: string): boolean {
  return UUID_REGEX.test(uuid);
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
