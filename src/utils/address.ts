import { fromBech32 } from '@cosmjs/encoding';

/**
 * Expected bech32 prefix for Manifest network addresses.
 */
export const MANIFEST_ADDRESS_PREFIX = 'manifest';

/**
 * Validates a bech32 address using cosmjs utilities.
 *
 * **Security:** Validates address format before sending to blockchain APIs.
 * Uses @cosmjs/encoding for proper bech32 decoding and validation.
 *
 * @param address - The address string to validate
 * @param expectedPrefix - Expected bech32 prefix (default: 'manifest')
 * @returns true if address is valid bech32 with expected prefix
 * @example
 * isValidBech32Address('manifest1abc...') // true
 * isValidBech32Address('cosmos1abc...') // false (wrong prefix)
 * isValidBech32Address('invalid') // false
 */
export function isValidBech32Address(
  address: string,
  expectedPrefix: string = MANIFEST_ADDRESS_PREFIX
): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  try {
    const decoded = fromBech32(address);
    return decoded.prefix === expectedPrefix;
  } catch {
    return false;
  }
}

/**
 * Validates a Manifest network address.
 *
 * @param address - The address to validate
 * @returns true if address is a valid Manifest address
 */
export function isValidManifestAddress(address: string): boolean {
  return isValidBech32Address(address, MANIFEST_ADDRESS_PREFIX);
}

/**
 * Truncates a blockchain address for display
 * @param addr - The full address string
 * @param prefixLength - Number of characters to show at start (default: 10)
 * @param suffixLength - Number of characters to show at end (default: 6)
 * @param maxLength - Maximum length before truncation (default: 20)
 * @returns Truncated address string
 */
export function truncateAddress(
  addr: string,
  prefixLength: number = 10,
  suffixLength: number = 6,
  maxLength: number = 20
): string {
  if (!addr || addr.length <= maxLength) return addr;
  return `${addr.slice(0, prefixLength)}...${addr.slice(-suffixLength)}`;
}
