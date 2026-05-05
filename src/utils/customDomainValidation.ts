import { parse as parseTld } from 'tldts';
import { isValidFqdn, normalizeFqdn } from './connection';
import { getReservedDomainSuffixes } from '../api/billingParams';

/** Single source of truth for the apex-domain warning copy. Used by `validateAll`,
 *  the post-confirm domain-args merger, and any other consumer that needs to
 *  surface the "you can't CNAME at the apex" rule. */
export const APEX_WARNING =
  'This is an apex domain. CNAMEs at the apex are not allowed by RFC; use ALIAS / ANAME / CNAME-flattening (Cloudflare) at your registrar.';

/** DNS-record-type label used in confirmation/success copy. Branches on whether
 *  the target is the apex (CNAME-at-apex is forbidden, ALIAS/ANAME/flattening
 *  is the substitute). */
export function apexRecordKindLabel(isApexDomain: boolean): string {
  return isApexDomain ? 'ALIAS / ANAME / CNAME-flattened' : 'CNAME';
}

export interface CustomDomainValidationResult {
  /** Hard-blocking error: format invalid, reserved suffix, etc. */
  error?: string;
  /** Non-blocking warning surfaced in the UI (e.g. apex domain). */
  warning?: string;
}

/**
 * Pure format check: must be a valid FQDN (RFC 952/1123 hostname), not an IP.
 * Trailing dots are stripped before validation.
 *
 * Custom domains attach via DNS — they need a real hostname that resolves to a
 * provider FQDN, so IPv4 / IPv6 literals (which the hostname regex happens to
 * accept syntactically) are rejected up front.
 */
export function validateCustomDomainFormat(fqdn: string): string | null {
  const trimmed = normalizeFqdn(fqdn);
  if (trimmed.length === 0) return 'Custom domain must not be empty.';
  if (!isValidFqdn(trimmed)) return `"${fqdn}" is not a valid hostname.`;
  if (trimmed.split('.').length < 2) return `"${fqdn}" must include at least one dot (e.g. "app.example.com").`;
  if (parseTld(trimmed, { allowPrivateDomains: true }).isIp) {
    return `"${fqdn}" is an IP address — custom domains must be hostnames (e.g. "app.example.com"), not IPs.`;
  }
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
  const trimmed = normalizeFqdn(fqdn);
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
  const lower = normalizeFqdn(fqdn);
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

  let suffixes: string[] = [];
  try {
    suffixes = await getReservedDomainSuffixes();
  } catch {
    // Chain unreachable → don't block; the chain will reject authoritatively.
  }

  if (isReservedSuffix(fqdn, suffixes)) {
    return {
      error: `"${fqdn}" falls within a provider's reserved zone — pick a domain you control.`,
    };
  }

  if (isApex(fqdn)) {
    return { warning: APEX_WARNING };
  }

  return {};
}
