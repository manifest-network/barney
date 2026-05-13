/**
 * useDnsStatusPolling — single polling driver for custom-domain DNS state.
 *
 * One instance of this hook should run somewhere mounted whenever a wallet is
 * connected (we mount it in `MainLayout`, outside the sidebar's ErrorBoundary
 * so a sidebar render error doesn't take DNS state down with it). It iterates
 * the registry's running apps with `customDomains`, runs the existing
 * DoH + HTTPS probes for each, and writes per-domain `DnsStatusEntry` rows
 * into the AI store.
 *
 * Sidebar dots, the CustomDomainCard, AppCard's embedded custom-domain row,
 * and any future surface that wants to display DNS status read from the same
 * store slice — no per-component poll loops, no double-polling.
 *
 * Polling pauses when the tab is hidden (via `useVisibilityPolling`) and skips
 * apps whose domains have all reached a terminal state (`active` or `failed`).
 *
 * In-flight probes are tied to an AbortController that aborts on the next
 * poll tick and on unmount, so a wallet switch / navigation doesn't leak
 * pending DoH fetches that resolve onto a stale store.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useVisibilityPolling } from './useVisibilityPolling';
import { useAI } from './useAI';
import {
  computeStatus,
  probeHttps,
  resolveDnsViaDoh,
} from '../utils/customDomainStatus';
import { resolveExpectedCnameTarget } from '../utils/connection';
import { isApex } from '../utils/customDomainValidation';
import { logError } from '../utils/errors';
import type { AppEntry } from '../registry/appRegistry';
import { dnsStatusKey, type DnsStatusEntry } from '../stores/aiStore';
import { DNS_POLL_INTERVAL_MS } from '../config/constants';

/** Candidate polling target — one per (app, custom-domain) pair. */
export interface DnsPollingTarget {
  app: AppEntry;
  domain: string;
  serviceName: string;
}

/** Pure derivation of polling candidates from the registry. Does NOT consult
 *  `dnsStatuses` — terminal-state filtering happens later, at poll-fire time,
 *  against the freshest slice via `dnsStatusesRef`. Exported for direct unit
 *  testing.
 *
 *  Keeping this pure-by-construction means the memo that wraps it only
 *  recomputes when the registry mutates, not on every probe write. */
export function deriveCandidateTargets(apps: readonly AppEntry[]): DnsPollingTarget[] {
  const list: DnsPollingTarget[] = [];
  for (const app of apps) {
    if (!app.customDomains || app.customDomains.length === 0) continue;
    if (app.status !== 'running') continue;
    for (const dom of app.customDomains) {
      list.push({ app, domain: dom.customDomain, serviceName: dom.serviceName });
    }
  }
  return list;
}

/** Predicate: is this domain in a terminal state (active or failed)?
 *  Encapsulates the once-active-stop-polling rule. */
function isTerminal(entry: DnsStatusEntry | undefined): boolean {
  return entry?.kind === 'active' || entry?.kind === 'failed';
}

export function useDnsStatusPolling(apps: readonly AppEntry[]): void {
  const { dnsStatuses, setDnsStatuses } = useAI();

  /** All candidate (app, domain) pairs from the running registry. Stable
   *  across `dnsStatuses` writes — re-derived only when `apps` changes. */
  const allTargets = useMemo(() => deriveCandidateTargets(apps), [apps]);

  /** Cheap inline reduce — drives `enabled` for the visibility hook. Reads
   *  the live `dnsStatuses` so polling actually stops once every candidate
   *  hits a terminal state. No allocation; the candidate list itself is
   *  reference-stable. */
  const hasNonTerminalTarget = allTargets.some(({ app, domain }) =>
    !isTerminal(dnsStatuses.get(dnsStatusKey(app.leaseUuid, domain))),
  );

  // Refs so the poll callback doesn't depend on dnsStatuses/targets directly
  // — `dnsStatuses` updates every successful poll (this very hook writes to
  // it), and depending on it would rebuild the callback on every cycle.
  // The callback reads via these refs to merge against the freshest map.
  const dnsStatusesRef = useRef(dnsStatuses);
  const allTargetsRef = useRef(allTargets);
  useEffect(() => { dnsStatusesRef.current = dnsStatuses; });
  useEffect(() => { allTargetsRef.current = allTargets; });

  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight probes when the hook unmounts (wallet switch, route
  // change, ErrorBoundary fallback). Without this, a 5s DoH fetch keeps
  // running and resolves onto a stale store.
  useEffect(() => () => abortRef.current?.abort(), []);

  const poll = useCallback(async () => {
    // Filter terminal targets at the moment polling fires, using the freshest
    // map (not the closure-captured snapshot from when the callback was
    // memoized). The candidate list itself never carries this filter, so
    // its memo doesn't churn on slice writes.
    const liveDns = dnsStatusesRef.current;
    const current = allTargetsRef.current.filter(
      ({ app, domain }) => !isTerminal(liveDns.get(dnsStatusKey(app.leaseUuid, domain))),
    );
    if (current.length === 0) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const updates = await Promise.all(current.map(async ({ app, domain, serviceName }) => {
      const expectedCnameTarget = resolveExpectedCnameTarget(app.connection, serviceName);
      try {
        const [dns, https] = await Promise.all([
          resolveDnsViaDoh(domain, ac.signal),
          probeHttps(domain, ac.signal),
        ]);
        const report = computeStatus({
          dns,
          https,
          expectedCname: expectedCnameTarget,
          isApex: isApex(domain),
        });
        const entry: DnsStatusEntry = {
          leaseUuid: app.leaseUuid,
          customDomain: domain,
          serviceName,
          kind: report.kind,
          expectedCnameTarget,
          ...(report.detail ? { detail: report.detail } : {}),
        };
        return entry;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return null;
        logError('useDnsStatusPolling', err);
        return null;
      }
    }));

    if (ac.signal.aborted) return;

    // Read the latest map via the ref — between when poll was scheduled and
    // when its awaits settled, any other writer (cross-tab sync, future
    // executor write) may have updated the slice. Merging from the closure
    // snapshot would clobber those.
    const next = new Map(dnsStatusesRef.current);
    for (const u of updates) {
      if (u) next.set(dnsStatusKey(u.leaseUuid, u.customDomain), u);
    }
    setDnsStatuses(next);
  }, [setDnsStatuses]);

  useVisibilityPolling(poll, DNS_POLL_INTERVAL_MS, {
    enabled: hasNonTerminalTarget,
    context: 'useDnsStatusPolling',
  });
}
