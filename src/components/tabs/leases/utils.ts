/**
 * Shared utility functions for the Leases tab components.
 */

/**
 * Validates a signature message before signing with the user's wallet.
 */
export function validateSignMessage(message: string, expectedPrefix: string): boolean {
  if (!message || typeof message !== 'string') return false;
  if (!message.startsWith(expectedPrefix)) return false;
  const safePattern = /^[a-zA-Z0-9\s:-]+$/;
  return safePattern.test(message);
}

/**
 * Formats a camelCase or snake_case key into a readable label.
 */
export function formatKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
