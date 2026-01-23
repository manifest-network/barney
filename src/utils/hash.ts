/**
 * Utility functions for hashing payloads.
 */

/**
 * Computes SHA-256 hash of the given data.
 * @param data - The data to hash (string or Uint8Array)
 * @returns The hash as a Uint8Array
 */
export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return new Uint8Array(hashBuffer);
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
 * Converts a hex string to a Uint8Array.
 */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Maximum payload size in bytes (2KB).
 */
export const MAX_PAYLOAD_SIZE = 2 * 1024;

/**
 * Validates payload size.
 * @param data - The payload data
 * @returns true if valid, false if too large
 */
export function validatePayloadSize(data: string | Uint8Array): boolean {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return bytes.length <= MAX_PAYLOAD_SIZE;
}

/**
 * Gets the size of a payload in bytes.
 */
export function getPayloadSize(data: string | Uint8Array): number {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return bytes.length;
}
