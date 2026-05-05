import { normalizeFqdn } from './connection';

/**
 * Browser-side custom-domain status detection.
 *
 * Until fred ships a server-side `domain_status` endpoint, status is
 * computed from two probes:
 *   1. DNS resolution via Cloudflare DoH (CNAME / A / AAAA)
 *   2. Opaque HTTPS probe (`fetch(..., { mode: 'no-cors' })`)
 *
 * A `pending_dns` state means "DNS not visible yet" — could be because:
 *   - The user hasn't added the CNAME
 *   - DoH or HTTPS probes are blocked by their network
 * The card surfaces a "verify locally with `dig`" hint after sustained `pending_dns`.
 */

const CLOUDFLARE_DOH = 'https://cloudflare-dns.com/dns-query';
const PROBE_TIMEOUT_MS = 5000;

export type CustomDomainStatusKind = 'pending_dns' | 'issuing_cert' | 'active' | 'failed';

/**
 * Status report for a custom domain.
 *
 * `kind` is the coarse 4-state machine the UI renders. `detail` is an optional
 * free-form sub-reason. Today the client-side compute only sets `kind`; the
 * `detail` slot is intentional forward-compat for when fred ships a server-side
 * `domain_status` endpoint that returns richer reasons (e.g. `acme_rate_limited`,
 * `dns01_challenge_failed`, `cert_expired`). Card consumers should display
 * `detail` as a sub-line under the status pill when present.
 */
export interface CustomDomainStatusReport {
  kind: CustomDomainStatusKind;
  detail?: string;
}


export interface DnsProbeResult {
  /** "ok" = at least one record resolved; "nxdomain"/"network_fail" = DNS not present or unreachable. */
  result: 'ok' | 'nxdomain' | 'network_fail';
  /** Resolved CNAME target (final, post-chain) when present. */
  cname?: string;
  /** Resolved IPv4/IPv6 (terminal record) when CNAME chain ends in an A/AAAA. */
  addresses?: string[];
}

export interface HttpsProbeResult {
  result: 'ok' | 'unreachable';
}

interface DohAnswer {
  name: string;
  type: number;
  TTL?: number;
  data: string;
}

interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

async function fetchDoh(fqdn: string, type: 'A' | 'AAAA' | 'CNAME', signal: AbortSignal): Promise<DohResponse | null> {
  const url = `${CLOUDFLARE_DOH}?name=${encodeURIComponent(fqdn)}&type=${type}`;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/dns-json' },
      signal,
    });
    if (!resp.ok) return null;
    return (await resp.json()) as DohResponse;
  } catch {
    return null;
  }
}

/** Resolve via Cloudflare DoH. Treats network errors and timeouts as `network_fail`. */
export async function resolveDnsViaDoh(fqdn: string, signal?: AbortSignal): Promise<DnsProbeResult> {
  const ac = new AbortController();
  // Honor an already-aborted external signal — addEventListener wouldn't fire post-hoc.
  if (signal?.aborted) ac.abort();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);

  try {
    const [aRes, aaaaRes, cnameRes] = await Promise.all([
      fetchDoh(fqdn, 'A', ac.signal),
      fetchDoh(fqdn, 'AAAA', ac.signal),
      fetchDoh(fqdn, 'CNAME', ac.signal),
    ]);

    if (aRes === null && aaaaRes === null && cnameRes === null) {
      return { result: 'network_fail' };
    }

    const cnameAnswer = cnameRes?.Answer?.find(a => a.type === 5);
    const aAnswers = (aRes?.Answer ?? []).filter(a => a.type === 1).map(a => a.data);
    const aaaaAnswers = (aaaaRes?.Answer ?? []).filter(a => a.type === 28).map(a => a.data);
    const allAddresses = [...aAnswers, ...aaaaAnswers];

    if (allAddresses.length > 0 || cnameAnswer) {
      return {
        result: 'ok',
        cname: cnameAnswer?.data?.replace(/\.$/, ''),
        addresses: allAddresses.length > 0 ? allAddresses : undefined,
      };
    }

    // No answers — disambiguate by DoH Status (RFC 1035 §4.1.1):
    //   0 NoError  + empty Answer → NODATA (domain exists but no record of that type) → nxdomain
    //   3 NXDOMAIN                                                                    → nxdomain
    //   2 SERVFAIL, 5 REFUSED, others                                                 → network_fail
    // Treating SERVFAIL/REFUSED as nxdomain would lock the card in pending_dns when the
    // problem is actually a transient resolver issue — keep the state honest.
    const statuses = [aRes?.Status, aaaaRes?.Status, cnameRes?.Status].filter(
      (s): s is number => typeof s === 'number',
    );
    const allBenign = statuses.length > 0 && statuses.every((s) => s === 0 || s === 3);
    return { result: allBenign ? 'nxdomain' : 'network_fail' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Opaque HTTPS probe: `fetch` with `mode: 'no-cors'`.
 * - Network success (any HTTP response, including 5xx) → `ok`
 * - Connection refused / DNS fail / TLS handshake error → `unreachable`
 * Don't read the body — the response is opaque.
 */
export async function probeHttps(fqdn: string, signal?: AbortSignal): Promise<HttpsProbeResult> {
  const ac = new AbortController();
  if (signal?.aborted) ac.abort();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);

  try {
    await fetch(`https://${fqdn}/`, { mode: 'no-cors', signal: ac.signal });
    return { result: 'ok' };
  } catch {
    return { result: 'unreachable' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface ComputeStatusInput {
  dns: DnsProbeResult;
  https: HttpsProbeResult;
  /** Provider-issued FQDN we expect the user's CNAME to point at. */
  expectedCname?: string;
}

/**
 * Pure status reducer:
 *   - DNS not present       → pending_dns
 *   - DNS resolves but HTTPS unreachable → issuing_cert (Traefik resolver in flight)
 *   - DNS + HTTPS ok        → active
 *   - DNS doesn't match expected target → pending_dns (user pointed at the wrong host)
 *
 * `failed` is reserved for an explicit fred status endpoint signal. Until that
 * exists, sustained `issuing_cert` is the closest approximation; the UI can
 * surface a hint after a long stall. The `detail` field is left blank by the
 * client-side compute and is the slot a future fred-backed reducer will fill.
 */
export function computeStatus(input: ComputeStatusInput): CustomDomainStatusReport {
  const { dns, https, expectedCname } = input;

  if (dns.result !== 'ok') return { kind: 'pending_dns' };

  if (expectedCname) {
    const expected = normalizeFqdn(expectedCname);
    const actual = dns.cname ? normalizeFqdn(dns.cname) : undefined;
    if (actual && actual !== expected) {
      // Wrong target: tell the user *what* they typed and *what we want*.
      // Without this, the card is indistinguishable from "no record at all"
      // and the 5-min "verify with dig" hint reads as a network problem.
      return {
        kind: 'pending_dns',
        detail: `Pointed at ${actual} — expected ${expected}`,
      };
    }
  }

  if (https.result === 'ok') return { kind: 'active' };
  return { kind: 'issuing_cert' };
}
