/**
 * useDnsStatusPolling — single polling driver for custom-domain DNS state.
 *
 * One instance of this hook should run somewhere mounted whenever a wallet is
 * connected (we mount it in `MainLayout`). It iterates the registry's running
 * apps with `customDomains`, runs the existing DoH + HTTPS probes for each,
 * and writes per-domain `DnsStatusEntry` rows into the AI store.
 *
 * Sidebar dots, the inline deploy_dns_status pill, and any future surface that
 * wants to display DNS status read from the same store slice — no
 * per-component poll loops, no double-polling.
 *
 * Polling pauses when the tab is hidden (via `useVisibilityPolling`) and skips
 * apps whose domains have all reached a terminal state (`active` or `failed`).
 */

import { useCallback, useMemo } from 'react';
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

const POLL_INTERVAL_MS = 30_000;

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

  const poll = useCallback(async () => {
    if (targets.length === 0) return;
    const updates = await Promise.all(targets.map(async ({ app, domain, serviceName }) => {
      const expectedCnameTarget = resolveExpectedCnameTarget(app.connection, serviceName);
      try {
        const [dns, https] = await Promise.all([
          resolveDnsViaDoh(domain),
          probeHttps(domain),
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
        logError('useDnsStatusPolling', err);
        return null;
      }
    }));

    // Merge into the existing map; preserve terminal states for apps not in targets.
    const next = new Map(dnsStatuses);
    for (const u of updates) {
      if (u) next.set(dnsStatusKey(u.leaseUuid, u.customDomain), u);
    }
    setDnsStatuses(next);
  }, [targets, dnsStatuses, setDnsStatuses]);

  useVisibilityPolling(poll, POLL_INTERVAL_MS, {
    enabled: targets.length > 0,
    context: 'useDnsStatusPolling',
  });
}
