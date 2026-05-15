import { normalizeFqdn } from './connection';

/**
 * Browser-side custom-domain status detection.
 *
 * Until fred ships a server-side `domain_status` endpoint, status is
 * computed from two probes:
 *   1. DNS resolution via DoH against multiple public resolvers (CNAME / A / AAAA)
 *   2. Opaque HTTPS probe (`fetch(..., { mode: 'no-cors' })`)
 *
 * **Why multiple DoH providers.** Public recursive resolvers do RFC 2308
 * negative caching: an `NXDOMAIN` is cached for `min(SOA.MINIMUM, SOA.TTL)`,
 * which on a cheap registrar's SOA can be 30 min. If we polled only one
 * provider, a user who added the record T seconds after we first queried
 * would be stuck on `pending_dns` until that provider's cache expired.
 *
 * Querying Cloudflare AND Google in parallel gives us two independent caches.
 * If either resolver sees the record, we take its answer — the other's stale
 * NXDOMAIN doesn't matter. Worst case (both have it cached) only happens if
 * both polled at nearly the same instant pre-create, which is much narrower
 * than a single provider's window. (Quad9's JSON DoH retired 2025-05; we'd
 * add a third when another no-auth JSON resolver becomes stable.)
 *
 * A `pending_dns` state means "DNS not visible yet" — could be because:
 *   - The user hasn't added the CNAME
 *   - Both providers have a stale NXDOMAIN cache (resolves itself within minutes)
 *   - DoH or HTTPS probes are blocked by their network
 * The card surfaces a hint after sustained `pending_dns`.
 */

interface DohProvider {
  /** Short identifier for logs. */
  name: string;
  /** Endpoint URL; receives `?name=&type=` query params. */
  url: string;
  /** Per-provider headers (e.g. Accept: application/dns-json for Cloudflare). */
  headers: HeadersInit;
}

/**
 * Resolvers we fan out to. Both speak the same JSON response shape (the
 * de-facto standard from Google's pre-RFC-8484 spec, also implemented by
 * Cloudflare). Adding a provider: append a `DohProvider` here — no other
 * change required.
 */
const DOH_PROVIDERS: readonly DohProvider[] = [
  // Cloudflare 1.1.1.1 — JSON via `Accept: application/dns-json`
  { name: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query', headers: { Accept: 'application/dns-json' } },
  // Google 8.8.8.8 — JSON natively at /resolve (independent cache from Cloudflare)
  { name: 'google', url: 'https://dns.google/resolve', headers: {} },
];

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

async function fetchDoh(provider: DohProvider, fqdn: string, type: 'A' | 'AAAA' | 'CNAME', signal: AbortSignal): Promise<DohResponse | null> {
  const url = `${provider.url}?name=${encodeURIComponent(fqdn)}&type=${type}`;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: provider.headers,
      signal,
    });
    if (!resp.ok) return null;
    return (await resp.json()) as DohResponse;
  } catch {
    return null;
  }
}

/** Probe one DoH provider for A + AAAA + CNAME and reduce to a DnsProbeResult. */
async function probeOneProvider(provider: DohProvider, fqdn: string, signal: AbortSignal): Promise<DnsProbeResult> {
  const [aRes, aaaaRes, cnameRes] = await Promise.all([
    fetchDoh(provider, fqdn, 'A', signal),
    fetchDoh(provider, fqdn, 'AAAA', signal),
    fetchDoh(provider, fqdn, 'CNAME', signal),
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
}

/**
 * Resolve DNS via multiple public DoH resolvers in parallel.
 *
 * Reduction rules:
 *   - Any provider returns `ok` → take that one (the others' stale NXDOMAIN
 *     caches are irrelevant once one resolver has the record).
 *   - All providers return `nxdomain` (or a mix of nxdomain / network_fail
 *     where at least one is nxdomain) → `nxdomain`. A definitive
 *     "doesn't exist" from any provider is more authoritative than a
 *     network failure on the others.
 *   - All providers return `network_fail` → `network_fail`.
 *
 * For multiple `ok` results, we prefer the one with a CNAME answer
 * (the wrong-target detection in `computeStatus` needs the CNAME to do
 * anything useful); otherwise the first.
 */
export async function resolveDnsViaDoh(fqdn: string, signal?: AbortSignal): Promise<DnsProbeResult> {
  const ac = new AbortController();
  // Honor an already-aborted external signal — addEventListener wouldn't fire post-hoc.
  if (signal?.aborted) ac.abort();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);

  try {
    const results = await Promise.all(
      DOH_PROVIDERS.map((p) => probeOneProvider(p, fqdn, ac.signal)),
    );

    const positive = results.filter((r) => r.result === 'ok');
    if (positive.length > 0) {
      return positive.find((r) => r.cname) ?? positive[0];
    }
    const anyNxdomain = results.some((r) => r.result === 'nxdomain');
    return { result: anyNxdomain ? 'nxdomain' : 'network_fail' };
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
  /** True iff `fqdn` is the zone apex. Apex domains legitimately resolve to
   *  A/AAAA via ALIAS / ANAME / CNAME-flattening (RFC 1912 / RFC 1034 §3.6.2
   *  forbid CNAME at apex). Without this flag, computeStatus can't tell a
   *  correctly-configured apex from a non-apex pointed via A at an unrelated
   *  HTTPS host — the latter would fall through to the no-cors HTTPS probe,
   *  which lets any responsive endpoint flash `active`. Caller should compute
   *  via `isApex()` from `customDomainValidation.ts`. Defaults to non-apex
   *  (the more conservative require-CNAME path) when omitted. */
  isApex?: boolean;
}

/**
 * Pure status reducer:
 *   - DNS not present       → pending_dns
 *   - DNS resolves but HTTPS unreachable → issuing_cert (Traefik resolver in flight)
 *   - DNS + HTTPS ok        → active
 *   - DNS doesn't match expected target → pending_dns (wrong CNAME, or A-only on non-apex)
 *
 * `failed` is reserved for an explicit fred status endpoint signal. Until that
 * exists, sustained `issuing_cert` is the closest approximation; the UI can
 * surface a hint after a long stall. The `detail` field is left blank by the
 * client-side compute and is the slot a future fred-backed reducer will fill.
 */
export function computeStatus(input: ComputeStatusInput): CustomDomainStatusReport {
  const { dns, https, expectedCname, isApex } = input;

  if (dns.result !== 'ok') return { kind: 'pending_dns' };

  // Without an expected CNAME target we can't validate the user's DNS
  // configuration. Reaching `active` here would terminal-lock a false-positive:
  // the HTTPS no-cors probe succeeds for any responsive HTTPS host, and the
  // polling driver filters terminal entries out at useDnsStatusPolling.ts:108,
  // so a later registry update populating `connection`/the target wouldn't
  // trigger a re-poll. Stay in `pending_dns` until the target is known.
  //
  // Common windows where target is undefined:
  //  - `fallbackToChainState` (fred timeout / fred throws) doesn't populate
  //    `connection` — Task #36 ships customDomains via fallback but the
  //    connection object stays undefined until a successful Fred round-trip.
  //  - Stack deploys before the service-level fqdn has landed.
  //  - Any path that calls `resolveExpectedCnameTarget` before a successful
  //    `getLeaseConnectionInfo` returns.
  //
  // Apex domains don't bypass this gate either — without an oracle to
  // validate against, there's no way to distinguish a correctly-configured
  // apex from a misconfigured one (same terminal-lock hazard as non-apex).
  if (!expectedCname) {
    return { kind: 'pending_dns', detail: 'Waiting for provider info…' };
  }

  const expected = normalizeFqdn(expectedCname);
  const actual = dns.cname ? normalizeFqdn(dns.cname) : undefined;

  if (actual && actual !== expected) {
    // Wrong CNAME target: tell the user *what* they typed and *what we want*.
    // Without this, the card is indistinguishable from "no record at all"
    // and the 5-min "verify with dig" hint reads as a network problem.
    return {
      kind: 'pending_dns',
      detail: `Pointed at ${actual} — expected ${expected}`,
    };
  }
  if (!actual && !isApex) {
    // No CNAME, expected one, and not an apex. The user pointed A/AAAA at
    // an unrelated host. Without this branch, the HTTPS no-cors probe
    // below would let ANY responsive endpoint flash `active` and the
    // sidebar dot would go green for someone else's app.
    //
    // Apex domains skip this check because RFC 1912 / RFC 1034 §3.6.2
    // forbid CNAME at the apex — apexes legitimately serve from A/AAAA
    // via ALIAS / ANAME / CNAME-flattening. There IS a residual hole on
    // the apex side: a user who points the apex A record at an unrelated
    // responsive HTTPS host still gets a false `active` here, because
    // browser fetch with `mode: 'no-cors'` can't verify which origin
    // actually answered. The authoritative fix is a fred read-side
    // status endpoint (ENG-59 follow-up); this reducer only closes the
    // non-apex hole, which is the larger blast radius today.
    return {
      kind: 'pending_dns',
      detail: `Expected a CNAME to ${expected} — got an A/AAAA record. Replace with a CNAME (apex domains: use ALIAS / ANAME instead).`,
    };
  }

  if (https.result === 'ok') return { kind: 'active' };
  return { kind: 'issuing_cert' };
}
