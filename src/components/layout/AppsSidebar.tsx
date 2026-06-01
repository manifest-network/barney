/**
 * AppsSidebar — wallet info, credits, running apps list.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useChain } from '@cosmos-kit/react';
import { LogOut, Circle, Zap, History, RotateCcw } from 'lucide-react';
import { useAI } from '../../hooks/useAI';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { getApps, reconcileWithChain, subscribeToRegistry, type AppEntry } from '../../registry/appRegistry';
import { getCreditAccount, getCreditEstimate, getLeasesByTenant, LeaseState } from '../../api/billing';
import { DENOMS } from '../../api/config';
import { fromBaseUnits } from '../../utils/format';
import { truncateAddress } from '../../utils/address';
import { logError } from '../../utils/errors';
import { CHAIN_NAME } from '../../config/chain';
import { findExampleByAppName, buildExampleManifest } from '../../config/exampleApps';
import { SECONDS_PER_HOUR, AUTO_REFRESH_INTERVAL_MS } from '../../config/constants';
import { useVisibilityPolling } from '../../hooks/useVisibilityPolling';
import { dnsStatusKey, type DnsStatusEntry } from '../../stores/aiStore';
import type { CustomDomainStatusKind } from '../../utils/customDomainStatus';
import { aggregateDnsKind } from './aggregateDnsKind';

const DNS_LABELS: Record<CustomDomainStatusKind, string> = {
  pending_dns: 'Pending DNS',
  issuing_cert: 'Issuing certificate',
  active: 'Active',
  failed: 'Failed',
};

const DNS_DOT_CLASS: Record<CustomDomainStatusKind, string> = {
  pending_dns: 'apps-sidebar__dns-dot--pending',
  issuing_cert: 'apps-sidebar__dns-dot--issuing',
  active: 'apps-sidebar__dns-dot--active',
  failed: 'apps-sidebar__dns-dot--failed',
};
import { timeAgo } from '../../utils/format';

interface AppsSidebarProps {
  onClose?: () => void;
}

const MAX_RECENT = 5;

/** Hours in 30 days — used as the "full" reference for the credit gauge */
const CREDIT_GAUGE_MAX_HOURS = 24 * 30;

const STATUS_COLORS: Record<string, string> = {
  running: 'text-success-400',
  deploying: 'text-warning-400',
  stopped: 'text-surface-400',
  failed: 'text-error-400',
};

export function AppsSidebar({ onClose }: AppsSidebarProps) {
  const { address, disconnect, wallet } = useChain(CHAIN_NAME);
  const { sendMessage, attachPayload, dnsStatuses } = useAI();
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [credits, setCredits] = useState<number | null>(null);
  const [hoursRemaining, setHoursRemaining] = useState<number | null>(null);
  const [burnRate, setBurnRate] = useState<number | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  // Load apps and credit info, reconcile with chain state
  const refresh = useCallback(async () => {
    if (!address) return;

    // Reconcile registry with on-chain lease state
    try {
      const [activeLeases, pendingLeases] = await Promise.all([
        getLeasesByTenant(address, LeaseState.LEASE_STATE_ACTIVE),
        getLeasesByTenant(address, LeaseState.LEASE_STATE_PENDING),
      ]);
      const leaseStates = new Map<string, 'active' | 'pending'>();
      for (const l of pendingLeases) leaseStates.set(l.uuid, 'pending');
      for (const l of activeLeases) leaseStates.set(l.uuid, 'active');
      reconcileWithChain(address, leaseStates);
    } catch (error) {
      logError('AppsSidebar.refresh.reconcile', error);
    }

    // Re-read after reconciliation
    setApps(getApps(address));

    // Credit balance — always available via creditAccount
    try {
      const creditResponse = await getCreditAccount(address);
      const pwrBal = creditResponse.balances.find(
        (b) => b.denom === DENOMS.PWR || b.denom.includes('upwr'),
      );
      setCredits(pwrBal ? fromBaseUnits(pwrBal.amount, pwrBal.denom) : 0);
    } catch (error) {
      logError('AppsSidebar.refresh.credits', error);
    }

    // Burn rate / time remaining — only meaningful with active leases
    try {
      const estimate = await getCreditEstimate(address);
      let ratePerSecond = 0;
      if (estimate?.totalRatePerSecond) {
        for (const rate of estimate.totalRatePerSecond) {
          ratePerSecond += fromBaseUnits(rate.amount, rate.denom);
        }
      }
      if (ratePerSecond > 0 && estimate?.estimatedDurationSeconds) {
        setHoursRemaining(Math.floor(Number(estimate.estimatedDurationSeconds) / SECONDS_PER_HOUR));
        setBurnRate(Math.round(ratePerSecond * SECONDS_PER_HOUR * 100) / 100);
      } else {
        setHoursRemaining(null);
        setBurnRate(null);
      }
    } catch (error) {
      logError('AppsSidebar.refresh.estimate', error);
    }
  }, [address]);

  useVisibilityPolling(refresh, AUTO_REFRESH_INTERVAL_MS, {
    enabled: !!address,
    immediate: false,
    context: 'AppsSidebar.refresh',
  });

  // Immediate fetch on mount and when address changes (wallet switch).
  // The hook's ref sync absorbs callback changes without restarting
  // the timer, but doesn't re-fetch — this effect handles that.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  // Subscribe to in-tab registry mutations so mid-tool-execution writes
  // (e.g. executeAppStatus refreshing customDomains, executeConfirmedDeployApp
  // flipping status) flow into the sidebar immediately instead of waiting up
  // to AUTO_REFRESH_INTERVAL_MS for the next poll.
  useEffect(() => {
    if (!address) return;
    return subscribeToRegistry((mutatedAddress) => {
      if (mutatedAddress === address) {
        setApps(getApps(address));
      }
    });
  }, [address]);

  const runningApps = apps.filter((a) => a.status === 'running' || a.status === 'deploying');

  // DNS status polling is mounted in MainLayout (outside the sidebar's
  // ErrorBoundary). All custom-domain surfaces read from `aiStore.dnsStatuses`.

  const countRef = useRef(runningApps.length);
  const badgeRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (runningApps.length !== countRef.current) {
      countRef.current = runningApps.length;
      const el = badgeRef.current;
      if (el) {
        el.classList.remove('apps-sidebar__apps-count--pop');
        // Force reflow to restart animation
        void el.offsetWidth;
        el.classList.add('apps-sidebar__apps-count--pop');
      }
    }
  }, [runningApps.length]);

  const recentDeploys = useMemo(() =>
    apps
      .filter((a) => a.status === 'stopped' || a.status === 'failed')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_RECENT),
    [apps]
  );

  return (
    <div className="apps-sidebar">
      {/* Wallet pill */}
      <div className="apps-sidebar__wallet">
        <div className="apps-sidebar__wallet-info">
          <div className="apps-sidebar__wallet-avatar">
            {wallet?.prettyName?.[0] || 'W'}
          </div>
          <div className="apps-sidebar__wallet-details">
            <span className="apps-sidebar__wallet-name">
              {wallet?.prettyName || 'Wallet'}
            </span>
            {address && (
              <button
                type="button"
                onClick={() => copyToClipboard(address)}
                className="apps-sidebar__wallet-address"
                aria-label="Copy address to clipboard"
                title="Click to copy address"
              >
                {isCopied(address) ? 'Copied!' : truncateAddress(address)}
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={async () => { try { await disconnect(); } catch (error) { logError('AppsSidebar.disconnect', error); } onClose?.(); }}
          className="apps-sidebar__disconnect"
          aria-label="Disconnect wallet"
          title="Disconnect"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>

      {/* Credits card */}
      <div className="apps-sidebar__credits">
        <div className="apps-sidebar__credits-header">
          <Zap className="w-4 h-4 text-primary-400" aria-hidden="true" />
          <span>Credits</span>
        </div>
        <div className="apps-sidebar__credits-amount">
          {credits != null ? `${credits.toLocaleString()} PWR` : '--'}
        </div>
        {hoursRemaining != null && (
          <div className="apps-sidebar__credits-runway">
            ~{hoursRemaining}h remaining
            {burnRate != null && (
              <span className="apps-sidebar__burn-rate"> · {burnRate} PWR/hr</span>
            )}
          </div>
        )}
        {/* Credit gauge */}
        {hoursRemaining != null && (
          <div className="apps-sidebar__gauge">
            <div
              className="apps-sidebar__gauge-fill"
              style={{
                width: `${Math.min(100, Math.max(5, (hoursRemaining / CREDIT_GAUGE_MAX_HOURS) * 100))}%`,
              }}
            />
          </div>
        )}
      </div>

      {/* Running apps */}
      <div className="apps-sidebar__apps">
        <div className="apps-sidebar__apps-header">
          <span>Running Apps</span>
          <span ref={badgeRef} className="apps-sidebar__apps-count">{runningApps.length}</span>
        </div>
        <div className="apps-sidebar__apps-list">
          {runningApps.length === 0 ? (
            <p className="apps-sidebar__apps-empty">No running apps</p>
          ) : (
            runningApps.map((app) => {
              // Per-app DNS status: collect this app's domain reports from the
              // shared store and aggregate. Worst-state-wins. Count badge appears
              // on the dot when an app has multiple domains so the user sees
              // "drill in for details" without needing to hover for the tooltip.
              //
              // Pass the full report list — including `undefined` for any
              // domain the polling driver hasn't probed yet — into the
              // aggregator. `aggregateDnsKind` treats `undefined` as pending,
              // so a multi-domain app won't flash green during the
              // partial-probe window (one of N landing active first, others
              // still in-flight). Note this is a behavior change for the
              // single-domain not-yet-probed case too: dot now correctly
              // shows pending instead of being driven by the old
              // `length === 0 → pending` fallback.
              const customDomains = app.customDomains ?? [];
              const hasDomains = customDomains.length > 0;
              const domainReports: (DnsStatusEntry | undefined)[] = customDomains
                .map((d) => dnsStatuses.get(dnsStatusKey(app.leaseUuid, d.customDomain)));
              const dnsKind: CustomDomainStatusKind = hasDomains
                ? aggregateDnsKind(domainReports)
                : 'pending_dns';
              const domainCount = customDomains.length;
              const tooltip = hasDomains
                ? (app.customDomains ?? [])
                    .map((d) => {
                      const r = dnsStatuses.get(dnsStatusKey(app.leaseUuid, d.customDomain));
                      const label = r ? DNS_LABELS[r.kind] : 'checking…';
                      // Surface mismatch detail in the tooltip so users see
                      // "wrong target" without needing to open the card.
                      return r?.detail
                        ? `${d.customDomain}: ${label} — ${r.detail}`
                        : `${d.customDomain}: ${label}`;
                    })
                    .join('\n')
                : undefined;
              return (
                <button
                  key={app.leaseUuid}
                  type="button"
                  onClick={() => {
                    sendMessage(`What's the status of ${app.name}?`);
                    onClose?.();
                  }}
                  className="apps-sidebar__app-item"
                >
                  <Circle
                    className={`w-2.5 h-2.5 fill-current ${STATUS_COLORS[app.status] || 'text-surface-400'}`}
                    aria-hidden="true"
                  />
                  <span className="apps-sidebar__app-name">{app.name}</span>
                  {hasDomains && (
                    <span
                      className={`apps-sidebar__dns-dot ${DNS_DOT_CLASS[dnsKind]}`}
                      title={tooltip}
                      aria-label={`DNS: ${DNS_LABELS[dnsKind]}${domainCount > 1 ? ` (${domainCount} domains)` : ''}`}
                    >
                      {domainCount > 1 && (
                        <span className="apps-sidebar__dns-count">{domainCount}</span>
                      )}
                    </span>
                  )}
                  {(() => {
                    // Show service count badge for stack deployments
                    if (app.manifest) {
                      try {
                        const m = JSON.parse(app.manifest);
                        if (m.services && typeof m.services === 'object' && !Array.isArray(m.services)) {
                          const count = Object.keys(m.services).length;
                          if (count > 1) return <span className="apps-sidebar__app-size">{count} svcs</span>;
                        }
                      } catch (error) { logError('AppsSidebar.parseManifest', error); }
                    }
                    return <span className="apps-sidebar__app-size">{app.size}</span>;
                  })()}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Recent deploys */}
      {recentDeploys.length > 0 && (
        <div className="apps-sidebar__recent">
          <div className="apps-sidebar__recent-header">
            <History className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Recent</span>
          </div>
          <div className="apps-sidebar__recent-list">
            {recentDeploys.map((app) => (
              <div key={app.leaseUuid} className="apps-sidebar__recent-item">
                <Circle
                  className={`w-2 h-2 fill-current ${STATUS_COLORS[app.status] || 'text-surface-400'}`}
                  aria-hidden="true"
                />
                <span className="apps-sidebar__recent-name">{app.name}</span>
                <span className="apps-sidebar__recent-time">{timeAgo(app.createdAt)}</span>
                <button
                  type="button"
                  onClick={async () => {
                    // Use stored manifest, or fall back to known example app manifest
                    let manifestJson = app.manifest;
                    if (!manifestJson) {
                      const example = findExampleByAppName(app.name);
                      if (example) manifestJson = buildExampleManifest(example);
                    }
                    if (manifestJson) {
                      const filename = `manifest-${app.name}.json`;
                      const blob = new Blob([manifestJson], { type: 'application/json' });
                      const file = new File([blob], filename, { type: 'application/json' });
                      const result = await attachPayload(file);
                      if (result.error) return;
                    }
                    // Re-deploy with the registry size hint (resolves, or falls
                    // back to cheapest in the executor); never blocked here.
                    sendMessage(`Deploy ${app.name}${app.size ? ` using ${app.size} tier` : ''}`);
                    onClose?.();
                  }}
                  className="apps-sidebar__recent-redeploy"
                  aria-label={`Re-deploy ${app.name}`}
                  title="Re-deploy"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Version */}
      <div className="apps-sidebar__version">
        <a
          href="https://github.com/manifest-network/barney"
          target="_blank"
          rel="noopener noreferrer"
          className="apps-sidebar__version-link"
          title="View source on GitHub"
        >
          v{import.meta.env.APP_VERSION}
        </a>
      </div>
    </div>
  );
}
