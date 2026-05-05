import type { DnsStatusEntry } from '../../stores/aiStore';
import type { CustomDomainStatusKind } from '../../utils/customDomainStatus';

/** Aggregate per-app DNS state — worst-state-wins so the sidebar dot signals
 *  "is anything wrong with my domains?" at a glance. */
export function aggregateDnsKind(reports: readonly DnsStatusEntry[]): CustomDomainStatusKind {
  if (reports.some((r) => r.kind === 'failed')) return 'failed';
  if (reports.some((r) => r.kind === 'pending_dns')) return 'pending_dns';
  if (reports.some((r) => r.kind === 'issuing_cert')) return 'issuing_cert';
  return 'active';
}
