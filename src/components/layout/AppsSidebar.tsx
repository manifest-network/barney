/**
 * AppsSidebar — wallet info, credits, running apps list.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useChain } from '@cosmos-kit/react';
import { LogOut, Circle, Zap, History, RotateCcw } from 'lucide-react';
import { useAI } from '../../hooks/useAI';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { getApps, reconcileWithChain, type AppEntry } from '../../registry/appRegistry';
import { discoverUnknownLeases, enrichDiscoveredLeases } from '../../registry/leaseDiscovery';
import { getCreditAccount, getCreditEstimate, getLeasesByTenant, LeaseState } from '../../api/billing';
import { DENOMS } from '../../api/config';
import { fromBaseUnits } from '../../utils/format';
import { truncateAddress } from '../../utils/address';
import { logError } from '../../utils/errors';
import { CHAIN_NAME } from '../../config/chain';
import { findExampleByAppName, buildExampleManifest } from '../../config/exampleApps';
import { SECONDS_PER_HOUR, AUTO_REFRESH_INTERVAL_MS } from '../../config/constants';
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
  const { address, disconnect, wallet, signArbitrary, isWalletConnected } = useChain(CHAIN_NAME);
  const { sendMessage, attachPayload } = useAI();
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [credits, setCredits] = useState<number | null>(null);
  const [hoursRemaining, setHoursRemaining] = useState<number | null>(null);
  const [burnRate, setBurnRate] = useState<number | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  // Track current address so fire-and-forget enrichment callbacks can detect stale closures
  const addressRef = useRef(address);
  useEffect(() => { addressRef.current = address; });

  // Stable wrapper for signArbitrary (same pattern as AppShell.tsx)
  const wrappedSignArbitrary = useCallback(
    async (signerAddress: string, data: string) => {
      if (typeof signArbitrary !== 'function') {
        throw new Error('Wallet does not support signArbitrary');
      }
      const result = await signArbitrary(signerAddress, data);
      return { pub_key: result.pub_key, signature: result.signature };
    },
    [signArbitrary]
  );

  // Load apps and credit info, reconcile with chain state, discover unknown leases
  const refresh = useCallback(async () => {
    if (!address) return;

    // Reconcile registry with on-chain lease state + discover unknown leases
    let allLeases: Awaited<ReturnType<typeof getLeasesByTenant>> = [];
    try {
      const [activeLeases, pendingLeases] = await Promise.all([
        getLeasesByTenant(address, LeaseState.LEASE_STATE_ACTIVE),
        getLeasesByTenant(address, LeaseState.LEASE_STATE_PENDING),
      ]);
      allLeases = [...activeLeases, ...pendingLeases];
      const activeUuids = new Set(allLeases.map((l) => l.uuid));
      reconcileWithChain(address, activeUuids);
    } catch (error) {
      logError('AppsSidebar.refresh.reconcile', error);
    }

    // Discover on-chain leases not in registry → add skeleton entries
    let discoveredUuids: string[] = [];
    try {
      if (allLeases.length > 0) {
        discoveredUuids = discoverUnknownLeases(address, allLeases);
      }
    } catch (error) {
      logError('AppsSidebar.refresh.discover', error);
    }
    // Always re-read after reconciliation + discovery (even if discovery failed)
    setApps(getApps(address));

    // Enrich discovered leases in the background
    if (discoveredUuids.length > 0) {
      const leaseMap = new Map(allLeases.map((l) => [l.uuid, l]));
      const canSign = isWalletConnected && typeof signArbitrary === 'function';
      const capturedAddress = address;
      enrichDiscoveredLeases(capturedAddress, discoveredUuids, leaseMap, canSign ? wrappedSignArbitrary : undefined)
        .then(() => {
          // Guard against stale closure — wallet may have changed during enrichment
          if (addressRef.current === capturedAddress) setApps(getApps(capturedAddress));
        })
        .catch((err) => {
          logError('AppsSidebar.refresh.enrich', err);
          // Re-read to surface any partial enrichment results
          if (addressRef.current === capturedAddress) setApps(getApps(capturedAddress));
        });
    }

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
  }, [address, isWalletConnected, wrappedSignArbitrary]);

  useEffect(() => {
    // Initial fetch — refresh is async (setState calls happen after awaits, not synchronously)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const interval = setInterval(refresh, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // Re-sync when tab becomes visible (cross-browser discovery case)
  useEffect(() => {
    const onVisChange = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisChange);
    return () => document.removeEventListener('visibilitychange', onVisChange);
  }, [refresh]);

  const runningApps = apps.filter((a) => a.status === 'running' || a.status === 'deploying');

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
            runningApps.map((app) => (
              <button
                key={app.leaseUuid}
                type="button"
                onClick={() => {
                  sendMessage(`app_status("${app.name}")`);
                  onClose?.();
                }}
                className="apps-sidebar__app-item"
              >
                <Circle
                  className={`w-2.5 h-2.5 fill-current ${STATUS_COLORS[app.status] || 'text-surface-400'}`}
                  aria-hidden="true"
                />
                <span className="apps-sidebar__app-name">{app.name}</span>
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
            ))
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
