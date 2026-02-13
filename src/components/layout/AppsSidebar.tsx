/**
 * AppsSidebar — wallet info, credits, running apps list.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useChain } from '@cosmos-kit/react';
import { LogOut, Circle, Zap, History, RotateCcw } from 'lucide-react';
import { useAI } from '../../hooks/useAI';
import { getApps, reconcileWithChain, type AppEntry } from '../../registry/appRegistry';
import { getCreditEstimate, getLeasesByTenant, LeaseState } from '../../api/billing';
import { DENOMS } from '../../api/config';
import { fromBaseUnits } from '../../utils/format';
import { truncateAddress } from '../../utils/address';
import { logError } from '../../utils/errors';
import { CHAIN_NAME } from '../../config/chain';
import { findExampleByAppName, buildExampleManifest } from '../../config/exampleApps';

interface AppsSidebarProps {
  onClose?: () => void;
}

const MAX_RECENT = 5;

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const STATUS_COLORS: Record<string, string> = {
  running: 'text-success-400',
  deploying: 'text-warning-400',
  stopped: 'text-surface-400',
  failed: 'text-error-400',
};

export function AppsSidebar({ onClose }: AppsSidebarProps) {
  const { address, disconnect, wallet } = useChain(CHAIN_NAME);
  const { sendMessage, attachPayload } = useAI();
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [credits, setCredits] = useState<number | null>(null);
  const [hoursRemaining, setHoursRemaining] = useState<number | null>(null);
  const [burnRate, setBurnRate] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  // Load apps and credit info, reconcile with chain state
  const refresh = useCallback(async () => {
    if (!address) return;

    // Reconcile registry with on-chain lease state
    try {
      const [activeLeases, pendingLeases] = await Promise.all([
        getLeasesByTenant(address, LeaseState.LEASE_STATE_ACTIVE),
        getLeasesByTenant(address, LeaseState.LEASE_STATE_PENDING),
      ]);
      const activeUuids = new Set([
        ...activeLeases.map((l) => l.uuid),
        ...pendingLeases.map((l) => l.uuid),
      ]);
      reconcileWithChain(address, activeUuids);
    } catch (error) {
      logError('AppsSidebar.refresh.reconcile', error);
    }

    // Re-read after reconciliation
    setApps(getApps(address));

    try {
      const estimate = await getCreditEstimate(address);
      if (estimate?.currentBalance) {
        for (const bal of estimate.currentBalance) {
          if (bal.denom === DENOMS.PWR || bal.denom.includes('upwr')) {
            setCredits(fromBaseUnits(bal.amount, bal.denom));
            break;
          }
        }
      }
      // Only show time remaining when credits are actively being spent
      let ratePerSecond = 0;
      if (estimate?.totalRatePerSecond) {
        for (const rate of estimate.totalRatePerSecond) {
          ratePerSecond += fromBaseUnits(rate.amount, rate.denom);
        }
      }
      if (ratePerSecond > 0 && estimate?.estimatedDurationSeconds) {
        setHoursRemaining(Math.floor(Number(estimate.estimatedDurationSeconds) / 3600));
        setBurnRate(Math.round(ratePerSecond * 3600 * 100) / 100);
      } else {
        setHoursRemaining(null);
        setBurnRate(null);
      }
    } catch (error) {
      logError('AppsSidebar.refresh', error);
    }
  }, [address]);

  useEffect(() => {
    // Initial fetch — refresh is async (setState calls happen after awaits, not synchronously)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
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
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(address);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch (error) {
                    logError('AppsSidebar.copyAddress', error);
                  }
                }}
                className="apps-sidebar__wallet-address"
                aria-label="Copy address to clipboard"
                title="Click to copy address"
              >
                {copied ? 'Copied!' : truncateAddress(address)}
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
                width: `${Math.min(100, Math.max(5, (hoursRemaining / 720) * 100))}%`,
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
                <span className="apps-sidebar__app-size">{app.size}</span>
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
    </div>
  );
}
