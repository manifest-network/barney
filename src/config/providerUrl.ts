/**
 * The SDK's canonical provider URL lookup key: the WHATWG-normalized href
 * without trailing slashes. Paths are significant. Returns undefined for
 * anything but an absolute HTTP(S) URL, so callers report their own setting
 * without echoing malformed values (which can contain credentials).
 */
export function canonicalProviderUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.href.replace(/\/+$/, '');
    }
  } catch {
    // Not a URL.
  }
  return undefined;
}
