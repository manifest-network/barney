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

  // Cancel any in-flight probes when the candidate set changes (wallet switch,
  // app attach/detach) or when the hook unmounts. React's effect-cleanup
  // semantics: cleanup runs before next effect setup OR on unmount, so this
  // fires on every `allTargets` change AND on hook teardown — one effect
  // covers all three transitions.
  //
  // Without this, a 5s DoH fetch kicked off for the previous candidate set
  // could resolve after a wallet-context reset cleared `dnsStatuses` and repopulate it
  // with stale lease/domain entries — especially when the new wallet has
  // zero targets so the next poll() tick never fires to call `abort()` itself.
  useEffect(() => () => abortRef.current?.abort(), [allTargets]);

  // Prune stale `dnsStatuses` entries whose keys are no longer in the live
  // candidate set. Runs reactively on `[allTargets]` because the canonical
  // trap (clear-then-reattach the same (lease, domain)) holds polling
  // DISABLED for its entire duration: `hasNonTerminalTarget` reads the stale
  // terminal `active` entry at line ~81 during render, `useVisibilityPolling`
  // is told `enabled=false`, and no poll fires while the trap is set — so
  // any prune logic inside the poll callback would never run. This effect is
  // the only place that can fire during the trap: a registry mutation
  // triggers a re-render, this effect runs after commit, evicts the stale
  // key, and the *next* render's `hasNonTerminalTarget` sees the empty slice
  // and re-enables polling. Registered AFTER the ref-sync effect (line 91)
  // so `dnsStatusesRef.current` is fresh — React runs effects in
  // registration order.
  //
  // No-op guard: scan keys first and bail without calling `setDnsStatuses`
  // when nothing needs eviction (the common case for an additive registry
  // mutation — adds a new domain without removing any). Avoids a re-render
  // on every `allTargets` change.
  //
  // Refs: PR #93 Copilot review comment 3243486930.
  useEffect(() => {
    const liveKeys = new Set(
      allTargets.map((t) => dnsStatusKey(t.app.leaseUuid, t.domain)),
    );
    let needsPrune = false;
    for (const key of dnsStatusesRef.current.keys()) {
      if (!liveKeys.has(key)) { needsPrune = true; break; }
    }
    if (!needsPrune) return;

    const next = new Map(dnsStatusesRef.current);
    for (const key of next.keys()) {
      if (!liveKeys.has(key)) next.delete(key);
    }
    setDnsStatuses(next);
  }, [allTargets, setDnsStatuses]);

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
    // Defensive: re-verify each result's (leaseUuid, customDomain) tuple is
    // still in the live candidate set before writing. Closes a narrow race:
    // the ref-update effect (line 91-92) and the cleanup-effect's abort
    // (line 99) both fire on render, in registration order. There's a
    // microtask gap between them where `Promise.all` could settle with the
    // ref freshly updated to a new candidate set but `signal.aborted` still
    // false (the abort fires after the merge runs). Without this, an
    // in-flight probe from the prior candidate set could land in the new
    // wallet's dnsStatuses. Linear scan; both lists are small.
    const liveTargets = allTargetsRef.current;
    for (const u of updates) {
      if (!u) continue;
      const stillTargeted = liveTargets.some(
        (t) => t.app.leaseUuid === u.leaseUuid && t.domain === u.customDomain,
      );
      if (!stillTargeted) continue;
      next.set(dnsStatusKey(u.leaseUuid, u.customDomain), u);
    }
    setDnsStatuses(next);
  }, [setDnsStatuses]);

  useVisibilityPolling(poll, DNS_POLL_INTERVAL_MS, {
    enabled: hasNonTerminalTarget,
    context: 'useDnsStatusPolling',
  });
}
