/**
 * Utility functions for hashing payloads.
 */

/**
 * Converts a string or Uint8Array to a guaranteed standalone Uint8Array.
 * Strings are UTF-8 encoded. Uint8Array views are copied to ensure the
 * result is not a view into a larger ArrayBuffer.
 */
export function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string'
    ? new TextEncoder().encode(data)
    : new Uint8Array(data);
}

/**
 * Computes SHA-256 hash of the given data.
 *
 * Handles the case where the input Uint8Array is a view into a larger
 * ArrayBuffer (non-zero byteOffset or smaller byteLength) by creating
 * a copy of the relevant bytes.
 *
 * @param data - The data to hash (string or Uint8Array)
 * @returns The hash as a Uint8Array
 */
export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', toBytes(data));
  return new Uint8Array(hashBuffer);
}

/**
 * Computes SHA-256 hash of the given data and returns it as a hex string.
 * Convenience function that combines sha256() and toHex().
 *
 * @param data - The data to hash (string or Uint8Array)
 * @returns The hash as a 64-character hex string
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const hash = await sha256(data);
  return toHex(hash);
}

/**
 * Converts a Uint8Array to a hex string.
 */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Maximum payload size in bytes (5KB).
 */
export const MAX_PAYLOAD_SIZE = 5 * 1024;

/**
 * Validates payload size.
 * @param data - The payload data
 * @returns true if valid, false if too large
 */
export function validatePayloadSize(data: string | Uint8Array): boolean {
  return toBytes(data).length <= MAX_PAYLOAD_SIZE;
}

/**
 * Gets the size of a payload in bytes.
 */
export function getPayloadSize(data: string | Uint8Array): number {
  return toBytes(data).length;
}
