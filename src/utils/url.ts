/**
 * Validates that a URL is safe to use in an img src attribute.
 *
 * **Security:** Prevents XSS attacks by blocking dangerous URL protocols.
 * Only allows http:// and https:// protocols, explicitly rejecting:
 * - javascript: URIs (XSS vector)
 * - data: URIs (can embed malicious content)
 * - file: URIs (local file access)
 * - Other non-http protocols
 *
 * @param url - The URL to validate
 * @returns true if the URL uses http:// or https://, false otherwise
 * @example
 * isValidImageUrl('https://example.com/image.png') // true
 * isValidImageUrl('javascript:alert(1)') // false
 * isValidImageUrl('data:image/png;base64,...') // false
 */
export function isValidImageUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;

  try {
    const parsed = new URL(url);
    // Only allow http and https protocols to prevent javascript: and data: URIs
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Gets a safe image URL, returning undefined if the URL is invalid
 * @param url - The URL to validate
 * @returns The URL if valid, undefined otherwise
 */
export function getSafeImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return isValidImageUrl(url) ? url : undefined;
}
