import { parse as parseTld } from 'tldts';
import { isValidFqdn } from './connection';
import { getReservedDomainSuffixes } from '../api/billingParams';

export interface CustomDomainValidationResult {
  /** Hard-blocking error: format invalid, reserved suffix, etc. */
  error?: string;
  /** Non-blocking warning surfaced in the UI (e.g. apex domain). */
  warning?: string;
}

/**
 * Pure format check: must be a valid FQDN (RFC 952/1123 hostname).
 * Trailing dots are stripped before validation.
 */
export function validateCustomDomainFormat(fqdn: string): string | null {
  const trimmed = fqdn.trim().replace(/\.$/, '');
  if (trimmed.length === 0) return 'Custom domain must not be empty.';
  if (!isValidFqdn(trimmed)) return `"${fqdn}" is not a valid hostname.`;
  if (trimmed.split('.').length < 2) return `"${fqdn}" must include at least one dot (e.g. "app.example.com").`;
  return null;
}

/**
 * Apex (registerable-domain) detection backed by the Mozilla Public Suffix List
 * via `tldts`. Returns true when `fqdn` *is* its registerable domain (no
 * subdomain left after stripping the public suffix), e.g. `example.com`,
 * `bbc.co.uk`, `mysite.github.io`. Returns false for subdomains and IPs.
 *
 * `allowPrivateDomains: true` is required so that PSL "private" entries
 * (`github.io`, `netlify.app`, `vercel.app`, ...) are treated as public
 * suffixes — otherwise `mysite.github.io` would be misclassified as a
 * subdomain of `github.io`. Apex CNAMEs are RFC 1034 §3.6.2 forbidden;
 * the caller surfaces a warning so the user reaches for ALIAS / ANAME /
 * CNAME-flattening at their registrar instead.
 */
export function isApex(fqdn: string): boolean {
  const trimmed = fqdn.trim().replace(/\.$/, '').toLowerCase();
  if (!trimmed) return false;
  const parsed = parseTld(trimmed, { allowPrivateDomains: true });
  if (parsed.isIp) return false;
  if (!parsed.domain) {
    // No registerable domain. Two sub-cases:
    //  - the input itself is a real public suffix (`co.uk`, `github.io`) — treat
    //    as apex conservatively so the user is warned rather than silently let
    //    through to a TX that registrars can't honor.
    //  - non-PSL bare hostname (`localhost`) — not a domain at all, return false.
    return parsed.isIcann === true || parsed.isPrivate === true;
  }
  return !parsed.subdomain;
}

/**
 * Reserved-suffix check matching chain semantics:
 * - Suffixes are stored with leading dots (e.g. ".barney0.manifest0.net")
 * - Match label-boundary suffix (case insensitive)
 * - Also covers the apex form (e.g. "barney0.manifest0.net" itself)
 */
export function isReservedSuffix(fqdn: string, suffixes: readonly string[]): boolean {
  const lower = fqdn.trim().replace(/\.$/, '').toLowerCase();
  for (const raw of suffixes) {
    const suf = raw.toLowerCase();
    if (!suf) continue;
    // suffix is ".x.y.z" — match label-boundary suffix or exact apex
    if (suf.startsWith('.')) {
      const apex = suf.slice(1);
      if (lower === apex) return true;
      if (lower.endsWith(suf)) return true;
    } else {
      // tolerate suffix without leading dot
      if (lower === suf) return true;
      if (lower.endsWith('.' + suf)) return true;
    }
  }
  return false;
}

/**
 * Composite validation: format + reserved-suffix (hard errors) and apex (warning).
 * Reserved-suffix list is fetched from chain `Params.reservedDomainSuffixes`.
 */
export async function validateAll(fqdn: string): Promise<CustomDomainValidationResult> {
  const formatError = validateCustomDomainFormat(fqdn);
  if (formatError) return { error: formatError };

  const trimmed = fqdn.trim().replace(/\.$/, '').toLowerCase();

  let suffixes: string[] = [];
  try {
    suffixes = await getReservedDomainSuffixes();
  } catch {
    // Chain unreachable → don't block; the chain will reject authoritatively.
  }

  if (isReservedSuffix(trimmed, suffixes)) {
    return {
      error: `"${fqdn}" falls within a provider's reserved zone — pick a domain you control.`,
    };
  }

  if (isApex(trimmed)) {
    return {
      warning:
        'This is an apex domain. CNAMEs at the apex are not allowed by RFC; use ALIAS / ANAME / CNAME-flattening (Cloudflare) at your registrar.',
    };
  }

  return {};
}
