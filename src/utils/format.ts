/**
 * Shared formatting utilities
 */

import { getDenomMetadata, UNIT_LABELS } from '../api/config';
import type { Unit } from '../api/sku';

// ============================================
// JSON Serialization Helpers
// ============================================

/** JSON replacer that converts BigInt values to strings to avoid JSON.stringify errors. */
export function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? String(value) : value;
}

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
 * Format a token amount with proper decimals and symbol.
 *
 * @param amount - The raw amount as a string (in base units)
 * @param denom - The token denomination
 * @param maxDecimals - Maximum fraction digits to display (default: 6)
 * @returns Formatted string like "1,234.56 MFX" or "0 DENOM" for invalid amounts
 */
export function formatAmount(amount: string, denom: string, maxDecimals = 6): string {
  const { exponent, symbol } = getDenomMetadata(denom);
  const parsed = parseInt(amount, 10);
  if (Number.isNaN(parsed)) {
    return `0 ${symbol}`;
  }
  const num = parsed / Math.pow(10, exponent);
  return `${num.toLocaleString(undefined, { maximumFractionDigits: maxDecimals })} ${symbol}`;
}

/**
 * Format a price amount with symbol and optional unit label.
 * Delegates to formatAmount for the core conversion, then appends a unit suffix.
 *
 * @param amount - Raw amount string (in base units, e.g., umfx)
 * @param denom - Denomination string
 * @param unit - Optional unit type for suffix (e.g., "/hr", "/day")
 * @returns Formatted price string like "1.5 MFX/hr" or "0 SYMBOL" for invalid amounts
 */
export function formatPrice(amount: string, denom: string, unit?: Unit): string {
  const base = formatAmount(amount, denom);
  if (unit != null) {
    const unitLabel = UNIT_LABELS[unit] ?? '';
    return `${base}${unitLabel}`;
  }
  return base;
}

/**
 * Parse a date input into a valid Date, returning null for
 * undefined, Go zero time, invalid dates, and year <= 1.
 */
function parseValidDate(input: Date | string | undefined): Date | null {
  if (!input) return null;
  if (typeof input === 'string' && input === '0001-01-01T00:00:00Z') return null;
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime()) || date.getFullYear() <= 1) return null;
  return date;
}

/**
 * Format a date for display.
 * Accepts Date objects (from manifestjs fromAmino), ISO strings, or undefined.
 * Handles null/empty dates, invalid dates, and the Go zero time.
 *
 * @param dateInput - Date object, ISO date string, or undefined
 * @param options - 'datetime' for full datetime, 'date' for date only (default: 'datetime')
 * @returns Formatted date string or '-' for invalid/empty dates
 */
export function formatDate(dateInput: Date | string | undefined, options: 'datetime' | 'date' = 'datetime'): string {
  const date = parseValidDate(dateInput);
  if (!date) return '-';
  return options === 'date' ? date.toLocaleDateString() : date.toLocaleString();
}

/**
 * Format a date as relative time (e.g., "2h ago", "3d ago").
 * Accepts Date objects (from manifestjs fromAmino), ISO strings, or undefined.
 * Falls back to absolute date for older dates.
 *
 * @param dateInput - Date object, ISO date string, or undefined
 * @returns Relative time string or '-' for invalid dates
 */
export function formatRelativeTime(dateInput: Date | string | undefined): string {
  const date = parseValidDate(dateInput);
  if (!date) return '-';

  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffDay < 30) return `${Math.floor(diffDay / 7)}w ago`;

  // Fall back to short date for older items
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Format a timestamp as a short relative time string (e.g., "just now", "5m ago", "2h ago", "3d ago").
 * Unlike formatRelativeTime, accepts a raw numeric timestamp (Date.now()-style).
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
 * Format a duration into human-readable format.
 * Accepts bigint (seconds from manifestjs fromAmino), string durations, or undefined.
 * Handles Go-style durations like "3600s", "7200000000000" (nanoseconds), or plain seconds.
 *
 * @param duration - Duration as bigint (seconds), string (e.g., "3600s", "7200000000000", "3600"), or undefined
 * @returns Human-readable string like "1h", "2h 30m", "45m", "30s"
 */
export function formatDuration(duration: bigint | string | undefined): string {
  if (duration == null) return '-';

  let totalSeconds: number;

  if (typeof duration === 'bigint') {
    totalSeconds = Number(duration);
  } else if (duration === '') {
    return '-';
  } else if (duration.endsWith('s')) {
    // Handle Go duration format with 's' suffix
    totalSeconds = parseInt(duration.slice(0, -1), 10);
  } else {
    const num = parseInt(duration, 10);
    // If number is very large (> 1 billion), assume nanoseconds
    if (num > 1_000_000_000) {
      totalSeconds = Math.floor(num / 1_000_000_000);
    } else {
      totalSeconds = num;
    }
  }

  if (Number.isNaN(totalSeconds) || totalSeconds < 0) return '-';
  if (totalSeconds === 0) return '0s';

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 && days === 0 && hours === 0) parts.push(`${seconds}s`);

  return parts.length > 0 ? parts.join(' ') : '0s';
}

/**
 * Coerce an unknown value to boolean.
 * Handles both boolean `true` and string `"true"` from tool arguments.
 */
export function toBool(value: unknown): boolean {
  return value === true || value === 'true';
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
