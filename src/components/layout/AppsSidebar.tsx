/**
 * AppsSidebar — wallet info, credits, running apps list.
 */

import { useState, useEffect, useCallback } from 'react';
import { useChain } from '@cosmos-kit/react';
import { LogOut, Circle, Zap } from 'lucide-react';
import { useAI } from '../../hooks/useAI';
import { getApps, updateApp, type AppEntry } from '../../registry/appRegistry';
import { getCreditEstimate, getLeasesByTenant, LeaseState } from '../../api/billing';
import { DENOMS } from '../../api/config';
import { fromBaseUnits } from '../../utils/format';
import { truncateAddress } from '../../utils/address';
import { logError } from '../../utils/errors';
import { CHAIN_NAME } from '../../config/chain';

interface AppsSidebarProps {
  onClose?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: 'text-success-400',
  deploying: 'text-warning-400',
  stopped: 'text-surface-400',
  failed: 'text-error-400',
};

export function AppsSidebar({ onClose }: AppsSidebarProps) {
  const { address, disconnect, wallet } = useChain(CHAIN_NAME);
  const { sendMessage } = useAI();
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [credits, setCredits] = useState<number | null>(null);
  const [hoursRemaining, setHoursRemaining] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  // Load apps and credit info, reconcile with chain state
  const refresh = useCallback(async () => {
    if (!address) return;

    let apps = getApps(address);

    // Reconcile: mark apps as stopped if lease is no longer active/pending
    try {
      const [activeLeases, pendingLeases] = await Promise.all([
        getLeasesByTenant(address, LeaseState.LEASE_STATE_ACTIVE),
        getLeasesByTenant(address, LeaseState.LEASE_STATE_PENDING),
      ]);
      const activeUuids = new Set([
        ...activeLeases.map((l) => l.uuid),
        ...pendingLeases.map((l) => l.uuid),
      ]);

      for (const app of apps) {
        if (
          (app.status === 'running' || app.status === 'deploying') &&
          !activeUuids.has(app.leaseUuid)
        ) {
          updateApp(address, app.leaseUuid, { status: 'stopped' });
          app.status = 'stopped';
        }
      }
    } catch (error) {
      logError('AppsSidebar.refresh.reconcile', error);
    }

    setApps(apps);

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
      if (estimate?.estimatedDurationSeconds) {
        setHoursRemaining(Math.floor(Number(estimate.estimatedDurationSeconds) / 3600));
      }
    } catch (error) {
      logError('AppsSidebar.refresh', error);
    }
  }, [address]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  const runningApps = apps.filter((a) => a.status === 'running' || a.status === 'deploying');

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
          <span className="apps-sidebar__apps-count">{runningApps.length}</span>
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
    </div>
  );
}
