/**
 * Shared formatting utilities
 */

import { DENOM_METADATA } from '../api/config';

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
  const metadata = DENOM_METADATA[denom];
  const exponent = metadata?.exponent ?? 6;
  return (amount * Math.pow(10, exponent)).toFixed(0);
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
  const metadata = DENOM_METADATA[denom];
  const exponent = metadata?.exponent ?? 6;
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
 * Format a date as relative time (e.g., "2h ago", "3d ago").
 * Falls back to absolute date for older dates.
 *
 * @param dateStr - ISO date string or undefined
 * @returns Relative time string or '-' for invalid dates
 */
export function formatRelativeTime(dateStr: string | undefined): string {
  if (!dateStr || dateStr === '0001-01-01T00:00:00Z') {
    return '-';
  }
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

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
 * Format a byte count for display (e.g., "1.2 KB" or "512 B").
 */
export function formatFileSize(bytes: number): string {
  return bytes >= 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${bytes} B`;
}

/**
 * Format a duration string into human-readable format.
 * Handles Go-style durations like "3600s", "7200000000000" (nanoseconds), or plain seconds.
 *
 * @param duration - Duration string (e.g., "3600s", "7200000000000", "3600")
 * @returns Human-readable string like "1h", "2h 30m", "45m", "30s"
 */
export function formatDuration(duration: string | undefined): string {
  if (!duration) return '-';

  let totalSeconds: number;

  // Handle Go duration format with 's' suffix
  if (duration.endsWith('s')) {
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
