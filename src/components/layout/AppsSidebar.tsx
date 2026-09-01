/**
 * AppsSidebar — wallet info, credits, running apps list.
 */

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { useChain } from '@cosmos-kit/react';
import { LogOut, Circle, Zap, History, RotateCcw } from 'lucide-react';
import { useAI } from '../../hooks/useAI';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import {
  getApps,
  subscribeToRegistry,
  type AppEntry,
} from '../../registry/appRegistry';
import { getCreditAccount, getCreditEstimate } from '../../api/billing';
import { withTimeout } from '../../api/utils';
import { DENOMS } from '../../api/config';
import { fromBaseUnits } from '../../utils/format';
import { truncateAddress } from '../../utils/address';
import { logError } from '../../utils/errors';
import { CHAIN_NAME } from '../../config/chain';
import { findExampleByAppName, buildExampleManifest } from '../../config/exampleApps';
import {
  AI_TOOL_API_TIMEOUT_MS,
  AUTO_REFRESH_INTERVAL_MS,
  SECONDS_PER_HOUR,
} from '../../config/constants';
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

interface WalletRenderContext {
  address: string | undefined;
}

interface WalletSnapshot<T> {
  context: WalletRenderContext;
  value: T;
}

interface CreditEstimateSnapshot {
  hoursRemaining: number | null;
  burnRate: number | null;
}

interface CreditRefreshFailure {
  balance: boolean;
  estimate: boolean;
}

function creditFailureMessage(
  failure: CreditRefreshFailure,
  hasLoadedBalance: boolean,
  hasLoadedEstimate: boolean,
): string {
  if (failure.balance && failure.estimate) {
    return hasLoadedBalance || hasLoadedEstimate
      ? 'Couldn’t refresh credit details.'
      : 'Couldn’t load credit details.';
  }
  if (failure.balance) {
    return hasLoadedBalance
      ? 'Couldn’t refresh credit balance.'
      : 'Couldn’t load credit balance.';
  }
  return hasLoadedEstimate
    ? 'Couldn’t refresh credit estimate.'
    : 'Couldn’t load credit estimate.';
}

function currentWalletValue<T>(
  snapshot: WalletSnapshot<T> | null,
  context: WalletRenderContext,
): T | null {
  return snapshot?.context === context
    ? snapshot.value
    : null;
}

export function AppsSidebar({ onClose }: AppsSidebarProps) {
  const { address, disconnect, wallet } = useChain(CHAIN_NAME);
  const { sendMessage, attachPayload, dnsStatuses } = useAI();
  // Unlike an address string, this identity changes for A → B → A. Registry
  // and credit snapshots from an earlier visit to A therefore remain hidden
  // until the current A lifecycle successfully refreshes them.
  const walletContext = useMemo(() => ({ address }), [address]);
  const [appsSnapshot, setAppsSnapshot] =
    useState<WalletSnapshot<AppEntry[]> | null>(null);
  const [creditBalanceSnapshot, setCreditBalanceSnapshot] =
    useState<WalletSnapshot<number> | null>(null);
  const [creditEstimateSnapshot, setCreditEstimateSnapshot] =
    useState<WalletSnapshot<CreditEstimateSnapshot> | null>(null);
  const [creditFailureSnapshot, setCreditFailureSnapshot] =
    useState<WalletSnapshot<CreditRefreshFailure> | null>(null);
  const [activeCreditRefreshContexts, setActiveCreditRefreshContexts] =
    useState<ReadonlySet<WalletRenderContext>>(() => new Set());
  const [pollRestartGeneration, setPollRestartGeneration] = useState(0);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const refreshGenerationRef = useRef(0);
  const currentWalletContextRef = useRef<WalletRenderContext | null>(walletContext);
  const activeCreditRefreshCountsRef = useRef(new Map<WalletRenderContext, number>());
  const pendingCreditRetryContextsRef = useRef(new Set<WalletRenderContext>());
  const creditRefreshOwnerContextRef = useRef(walletContext);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const restoreRetryFocusContextRef = useRef<WalletRenderContext | null>(null);

  const beginCreditRefresh = useCallback((context: WalletRenderContext) => {
    const counts = activeCreditRefreshCountsRef.current;
    const nextCount = (counts.get(context) ?? 0) + 1;
    counts.set(context, nextCount);
    if (nextCount === 1) {
      setActiveCreditRefreshContexts(new Set(counts.keys()));
    }
  }, []);

  const endCreditRefresh = useCallback((context: WalletRenderContext) => {
    const counts = activeCreditRefreshCountsRef.current;
    const currentCount = counts.get(context);
    if (currentCount === undefined) return;
    if (currentCount > 1) {
      counts.set(context, currentCount - 1);
      return;
    }
    counts.delete(context);
    // A stale pass may settle after unmount; update the ref for completeness,
    // but do not enqueue a state update on a component that no longer exists.
    if (currentWalletContextRef.current !== null) {
      setActiveCreditRefreshContexts(new Set(counts.keys()));
    }
  }, []);

  // Invalidate every outstanding refresh before passive effects can start the
  // new wallet's immediate polling lifecycle. Layout-effect ordering makes
  // this independent of hook declaration order; cleanup also invalidates work
  // that settles after unmount.
  useLayoutEffect(() => {
    currentWalletContextRef.current = walletContext;
    refreshGenerationRef.current += 1;
    return () => {
      if (currentWalletContextRef.current === walletContext) {
        currentWalletContextRef.current = null;
      }
      refreshGenerationRef.current += 1;
    };
  }, [walletContext, pollRestartGeneration]);

  // A button click reserves activity before the restarted poll can claim it.
  // Reconcile ownership from the replacement wallet's setup, not cleanup:
  // StrictMode replays effect cleanup without ending the wallet lifecycle.
  // The identity guard makes same-wallet replays no-ops and preserves the
  // reservation handoff; the narrow dependency avoids redundant effect runs.
  useEffect(() => {
    const previousContext = creditRefreshOwnerContextRef.current;
    if (previousContext === walletContext) return;
    pendingCreditRetryContextsRef.current.delete(previousContext);
    const counts = activeCreditRefreshCountsRef.current;
    const hadActivity = counts.delete(previousContext);
    creditRefreshOwnerContextRef.current = walletContext;
    if (hadActivity) {
      setActiveCreditRefreshContexts(new Set(counts.keys()));
    }
  }, [walletContext]);

  // Scope rendered registry and credit data as well as writes. This hides
  // wallet A's rows and values on the very render that switches to wallet B,
  // including when B's first refresh fails or times out.
  const apps = useMemo(
    () => currentWalletValue(appsSnapshot, walletContext) ?? [],
    [appsSnapshot, walletContext],
  );
  const credits = currentWalletValue(
    creditBalanceSnapshot,
    walletContext,
  );
  const currentEstimate = currentWalletValue(
    creditEstimateSnapshot,
    walletContext,
  );
  const hoursRemaining = currentEstimate?.hoursRemaining ?? null;
  const burnRate = currentEstimate?.burnRate ?? null;
  const creditFailure = currentWalletValue(
    creditFailureSnapshot,
    walletContext,
  );
  const creditFailureCopy = creditFailure
    && (creditFailure.balance || creditFailure.estimate)
    ? creditFailureMessage(
        creditFailure,
        credits !== null,
        currentEstimate !== null,
      )
    : null;
  const isCreditRefreshing = activeCreditRefreshContexts.has(walletContext);

  useEffect(() => {
    const focusContext = restoreRetryFocusContextRef.current;
    if (focusContext === null) return;
    if (focusContext !== walletContext) {
      restoreRetryFocusContextRef.current = null;
      return;
    }
    if (!isCreditRefreshing) {
      if (
        creditFailureCopy
        && document.activeElement === document.body
      ) retryButtonRef.current?.focus();
      restoreRetryFocusContextRef.current = null;
    }
  }, [creditFailureCopy, isCreditRefreshing, walletContext]);

  // Load apps and credit info. MainLayout owns the independent recurring
  // chain/registry reconciliation driver outside this sidebar's ErrorBoundary.
  const refresh = useCallback(async () => {
    const claimedRetryReservation = pendingCreditRetryContextsRef.current.delete(walletContext);
    if (!address || currentWalletContextRef.current !== walletContext) {
      if (claimedRetryReservation) endCreditRefresh(walletContext);
      return;
    }
    const refreshGeneration = refreshGenerationRef.current;
    if (document.activeElement === retryButtonRef.current) {
      restoreRetryFocusContextRef.current = walletContext;
    }
    if (!claimedRetryReservation) beginCreditRefresh(walletContext);

    try {
      setAppsSnapshot({ context: walletContext, value: getApps(address) });

      // Bound and run the independent credit reads together. A stalled RPC can
      // no longer pin useVisibilityPolling's in-flight guard for the session.
      const creditBalanceRequest = withTimeout(
        getCreditAccount(address),
        AI_TOOL_API_TIMEOUT_MS,
        'Sidebar credit-account refresh',
      ).then((creditResponse) => {
        const pwrBal = creditResponse.balances.find(
          (b) => b.denom === DENOMS.PWR || b.denom.includes('upwr'),
        );
        return pwrBal ? fromBaseUnits(pwrBal.amount, pwrBal.denom) : 0;
      });

      const creditEstimateRequest = withTimeout(
        getCreditEstimate(address),
        AI_TOOL_API_TIMEOUT_MS,
        'Sidebar credit-estimate refresh',
      ).then((estimate) => {
        let ratePerSecond = 0;
        if (estimate?.totalRatePerSecond) {
          for (const rate of estimate.totalRatePerSecond) {
            ratePerSecond += fromBaseUnits(rate.amount, rate.denom);
          }
        }
        if (ratePerSecond > 0 && estimate?.estimatedDurationSeconds) {
          return {
            hoursRemaining: Math.floor(Number(estimate.estimatedDurationSeconds) / SECONDS_PER_HOUR),
            burnRate: Math.round(ratePerSecond * SECONDS_PER_HOUR * 100) / 100,
          };
        }
        return { hoursRemaining: null, burnRate: null };
      });

      const [creditResult, estimateResult] = await Promise.allSettled([
        creditBalanceRequest,
        creditEstimateRequest,
      ]);

      // An older wallet's promises may settle after a context switch. Never let
      // those results overwrite the new wallet's sidebar state.
      if (
        refreshGeneration !== refreshGenerationRef.current
        || currentWalletContextRef.current !== walletContext
      ) return;

      if (creditResult.status === 'fulfilled') {
        setCreditBalanceSnapshot({
          context: walletContext,
          value: creditResult.value,
        });
      } else {
        logError('AppsSidebar.refresh.credits', creditResult.reason);
      }

      if (estimateResult.status === 'fulfilled') {
        setCreditEstimateSnapshot({
          context: walletContext,
          value: estimateResult.value,
        });
      } else {
        logError('AppsSidebar.refresh.estimate', estimateResult.reason);
      }

      const failure = {
        balance: creditResult.status === 'rejected',
        estimate: estimateResult.status === 'rejected',
      };
      setCreditFailureSnapshot({ context: walletContext, value: failure });

      if (failure.balance || failure.estimate) {
        return false;
      }
    } finally {
      endCreditRefresh(walletContext);
    }
  }, [address, beginCreditRefresh, endCreditRefresh, walletContext]);

  const pollRestartKey = pollRestartGeneration === 0
    ? address
    : `${address ?? 'disconnected'}:${pollRestartGeneration}`;

  const retryCreditRefresh = useCallback(() => {
    // The ref closes the pre-render window after any poller pass begins; the
    // disabled state provides the visible/a11y contract once React commits it.
    if (activeCreditRefreshCountsRef.current.has(walletContext)) return;
    if (document.activeElement === retryButtonRef.current) {
      restoreRetryFocusContextRef.current = walletContext;
    }
    pendingCreditRetryContextsRef.current.add(walletContext);
    beginCreditRefresh(walletContext);
    setPollRestartGeneration((generation) => generation + 1);
  }, [beginCreditRefresh, walletContext]);

  useVisibilityPolling(refresh, AUTO_REFRESH_INTERVAL_MS, {
    enabled: !!address,
    immediate: true,
    backoff: true,
    context: 'AppsSidebar.refresh',
    restartKey: pollRestartKey,
  });

  // Subscribe to in-tab registry mutations so mid-tool-execution writes
  // (e.g. executeAppStatus refreshing customDomains, executeConfirmedDeployApp
  // flipping status) flow into the sidebar immediately instead of waiting up
  // to AUTO_REFRESH_INTERVAL_MS for the next poll.
  useEffect(() => {
    if (!address) return;
    return subscribeToRegistry((mutatedAddress) => {
      if (
        mutatedAddress === address
        && currentWalletContextRef.current === walletContext
      ) {
        setAppsSnapshot({ context: walletContext, value: getApps(address) });
      }
    });
  }, [address, walletContext]);

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
        {creditFailureCopy && (
          // The toggling control must stay outside the assertive region, and
          // its busy label must not imply that an automatic poll was user-led.
          <div className="apps-sidebar__credits-error">
            <span role="alert">{creditFailureCopy}</span>
            <button
              type="button"
              ref={retryButtonRef}
              className="apps-sidebar__credits-retry"
              onClick={retryCreditRefresh}
              disabled={isCreditRefreshing}
              aria-busy={isCreditRefreshing}
            >
              {isCreditRefreshing ? 'Refreshing…' : 'Retry'}
            </button>
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
                    void sendMessage(`What's the status of ${app.name}?`);
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
                    void sendMessage(`Deploy ${app.name}${app.size ? ` using ${app.size} tier` : ''}`);
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
