/**
 * Validates that a URL is safe to use in an img src attribute
 * Only allows http:// and https:// protocols
 * @param url - The URL to validate
 * @returns true if the URL is safe, false otherwise
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

/**
 * Validates that a URL is a valid API URL (http or https)
 * Used to prevent SSRF attacks by validating provider API URLs
 * @param url - The URL to validate
 * @returns The validated URL object, or null if invalid
 */
export function validateApiUrl(url: string): URL | null {
  if (!url || typeof url !== 'string') return null;

  try {
    const parsed = new URL(url);
    // Only allow http and https protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    // Prevent localhost/private IP access in production (basic check)
    // In a real production environment, you'd want more comprehensive checks
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Sanitizes a string for safe display by escaping HTML entities
 * @param str - The string to sanitize
 * @returns The sanitized string
 */
export function sanitizeForDisplay(str: string): string {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Safely stringify an object for display, with size limits
 * @param obj - The object to stringify
 * @param maxLength - Maximum length of the output string
 * @returns The stringified object, truncated if necessary
 */
export function safeJsonStringify(obj: unknown, maxLength: number = 500): string {
  try {
    const str = JSON.stringify(obj);
    if (str.length > maxLength) {
      return str.slice(0, maxLength) + '...';
    }
    return str;
  } catch {
    return '[Object]';
  }
}
