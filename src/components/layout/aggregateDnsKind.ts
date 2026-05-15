import type { DnsStatusEntry } from '../../stores/aiStore';
import type { CustomDomainStatusKind } from '../../utils/customDomainStatus';

/** Aggregate per-app DNS state — worst-state-wins so the sidebar dot signals
 *  "is anything wrong with my domains?" at a glance.
 *
 *  `undefined` entries (no report from `useDnsStatusPolling` yet) are treated
 *  as `pending_dns`. A multi-domain app whose probes haven't all landed must
 *  not flash green when one of N is reported active — the caller passes the
 *  full per-domain report array including `undefined` for missing-from-store
 *  entries, and this function gives them the correct conservative weight. */
export function aggregateDnsKind(
  reports: readonly (DnsStatusEntry | undefined)[],
): CustomDomainStatusKind {
  if (reports.some((r) => r?.kind === 'failed')) return 'failed';
  if (reports.some((r) => !r || r.kind === 'pending_dns')) return 'pending_dns';
  if (reports.some((r) => r?.kind === 'issuing_cert')) return 'issuing_cert';
  return 'active';
}
