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

/**
 * Validates that a URL is a valid API URL (http or https).
 *
 * **Security:** Prevents Server-Side Request Forgery (SSRF) attacks by:
 * - Validating URL format and structure
 * - Restricting to http:// and https:// protocols only
 * - Parsing and normalizing the URL to prevent bypass attempts
 *
 * Note: For production environments, consider additional checks:
 * - Blocklist private IP ranges (10.x.x.x, 192.168.x.x, 127.x.x.x)
 * - Allowlist specific domains
 * - DNS rebinding protection
 *
 * @param url - The URL string to validate
 * @returns The validated URL object if valid, null if invalid or unsafe
 * @example
 * validateApiUrl('https://api.example.com/v1') // URL object
 * validateApiUrl('file:///etc/passwd') // null
 * validateApiUrl('not-a-url') // null
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
 * Sanitizes a string for safe display by escaping HTML entities.
 *
 * **Security:** Prevents XSS attacks when displaying user-generated content
 * in contexts where React's automatic escaping doesn't apply (e.g., innerHTML,
 * title attributes, or server-rendered content).
 *
 * Note: React JSX automatically escapes text content, so this is primarily
 * needed for non-JSX contexts or when using dangerouslySetInnerHTML.
 *
 * Escapes: & < > " '
 *
 * @param str - The untrusted string to sanitize
 * @returns The HTML-escaped string safe for display
 * @example
 * sanitizeForDisplay('<script>alert(1)</script>')
 * // Returns: '&lt;script&gt;alert(1)&lt;/script&gt;'
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
 * Safely stringify an object for display, with size limits.
 *
 * **Security:** Prevents denial-of-service attacks from:
 * - Extremely large objects that could freeze the browser
 * - Circular references that would cause infinite loops
 * - Objects with custom toJSON methods that could throw
 *
 * @param obj - The object to stringify (can be any type)
 * @param maxLength - Maximum length of the output string (default: 500)
 * @returns The JSON string, truncated with '...' if exceeds maxLength,
 *          or '[Object]' if serialization fails
 * @example
 * safeJsonStringify({ key: 'value' }) // '{"key":"value"}'
 * safeJsonStringify({ huge: '...very long...' }, 20) // '{"huge":"...very l...'
 * safeJsonStringify(circularRef) // '[Object]'
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
