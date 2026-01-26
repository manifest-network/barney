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
