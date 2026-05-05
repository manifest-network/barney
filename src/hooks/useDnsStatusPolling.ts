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
 * Sidebar dots, the inline deploy_dns_status pill, and any future surface that
 * wants to display DNS status read from the same store slice — no
 * per-component poll loops, no double-polling.
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
import { logError } from '../utils/errors';
import type { AppEntry } from '../registry/appRegistry';
import { dnsStatusKey, type DnsStatusEntry } from '../stores/aiStore';
import { DNS_POLL_INTERVAL_MS } from '../config/constants';

export function useDnsStatusPolling(apps: readonly AppEntry[]): void {
  const { dnsStatuses, setDnsStatuses } = useAI();

  /** Apps that have at least one domain whose status isn't yet terminal.
   *  Once every domain is `active` or `failed` we don't need to keep polling
   *  — the user can refresh via `app_status` to re-detect. */
  const targets = useMemo(() => {
    const list: { app: AppEntry; domain: string; serviceName: string }[] = [];
    for (const app of apps) {
      if (!app.customDomains || app.customDomains.length === 0) continue;
      if (app.status !== 'running') continue;
      for (const dom of app.customDomains) {
        const cur = dnsStatuses.get(dnsStatusKey(app.leaseUuid, dom.customDomain));
        if (cur && (cur.kind === 'active' || cur.kind === 'failed')) continue;
        list.push({ app, domain: dom.customDomain, serviceName: dom.serviceName });
      }
    }
    return list;
  }, [apps, dnsStatuses]);

  // Refs so the poll callback doesn't depend on dnsStatuses/targets directly
  // — `dnsStatuses` updates every successful poll (this very hook writes to
  // it), and depending on it would rebuild the callback on every cycle.
  // The callback reads via these refs to merge against the freshest map.
  const dnsStatusesRef = useRef(dnsStatuses);
  const targetsRef = useRef(targets);
  useEffect(() => { dnsStatusesRef.current = dnsStatuses; });
  useEffect(() => { targetsRef.current = targets; });

  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight probes when the hook unmounts (wallet switch, route
  // change, ErrorBoundary fallback). Without this, a 5s DoH fetch keeps
  // running and resolves onto a stale store.
  useEffect(() => () => abortRef.current?.abort(), []);

  const poll = useCallback(async () => {
    const current = targetsRef.current;
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
        const report = computeStatus({ dns, https, expectedCname: expectedCnameTarget });
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
    enabled: targets.length > 0,
    context: 'useDnsStatusPolling',
  });
}
