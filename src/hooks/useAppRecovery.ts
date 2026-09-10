/** Provider recovery runs independently of chain reconciliation and chat tools. */
import { useCallback, useContext, useEffect, useRef } from 'react';
import { hasPendingRecoveryAuthentication, hydrateDiscoveredApp, recoverySnapshotKey } from '../api/appDiscovery';
import { AIStoreContext } from '../contexts/aiStoreContext';
import { getAppByLease, getApps } from '../registry/appRegistry';
import type { AIStore } from '../stores/aiStore';
import {
  APP_RECOVERY_MAX_ATTEMPTS,
  APP_RECOVERY_POLL_INTERVAL_MS,
  AUTO_REFRESH_INTERVAL_MS,
} from '../config/constants';
import { logError } from '../utils/errors';
import { useVisibilityPolling } from './useVisibilityPolling';

interface RecoveryAttempt {
  snapshot: string;
  attempts: number;
  nextAttemptAt: number;
  retired: boolean;
}

const foregroundBusy = (state: AIStore): boolean => state.isStreaming
  || state.activeTransactionMessageId !== null || state.pendingConfirmation !== null;

export function useAppRecovery(address: string | undefined): void {
  const store = useContext(AIStoreContext);
  const attemptsRef = useRef(new Map<string, RecoveryAttempt>());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    attemptsRef.current.clear();
    abortRef.current?.abort();
    const unsubscribe = store?.subscribe((next, previous) => {
      if (next.authorizationEpoch !== previous.authorizationEpoch) {
        attemptsRef.current.clear();
        abortRef.current?.abort();
      } else if (next.address !== address || !next.signing || foregroundBusy(next)) {
        abortRef.current?.abort();
      }
    });
    return () => {
      abortRef.current?.abort();
      unsubscribe?.();
    };
  }, [address, store]);

  const refresh = useCallback(async (): Promise<void> => {
    const wallet = store?.getState();
    if (!address || wallet?.address !== address || !wallet.signing || foregroundBusy(wallet)
      || abortRef.current) return;
    // A previous timed-out mint still occupies the SDK signer. Waiting for it
    // is scheduling, not a failed attempt by every other app in the inventory.
    if (hasPendingRecoveryAuthentication(wallet.signing.authTokens)) return;

    const apps = getApps(address);
    const live = new Set(apps.map(app => app.leaseUuid));
    for (const leaseUuid of attemptsRef.current.keys()) {
      if (!live.has(leaseUuid)) attemptsRef.current.delete(leaseUuid);
    }

    // Unattempted leases come first; retries never starve a larger inventory.
    const candidates = apps.flatMap(app => {
      if (!app.providerUrl || !app.chainState || app.chainState === 'absent'
        || app.provisionState === 'failed'
        || (app.provisionState === 'confirmed' && app.url && app.connection)) return [];
      const snapshot = recoverySnapshotKey(app);
      let attempt = attemptsRef.current.get(app.leaseUuid);
      if (!attempt || attempt.snapshot !== snapshot) {
        attempt = { snapshot, attempts: 0, nextAttemptAt: 0, retired: false };
        attemptsRef.current.set(app.leaseUuid, attempt);
      }
      if (attempt.retired || attempt.attempts >= APP_RECOVERY_MAX_ATTEMPTS
        || attempt.nextAttemptAt > Date.now()) return [];
      return [{ app, attempt }];
    }).sort((left, right) => left.attempt.nextAttemptAt - right.attempt.nextAttemptAt);
    const candidate = candidates[0];
    if (!candidate) return;

    const { app, attempt } = candidate;
    const abort = new AbortController();
    abortRef.current = abort;
    attempt.attempts++;
    try {
      const observation = await hydrateDiscoveredApp(address, app, wallet.signing, { signal: abort.signal });
      if (abort.signal.aborted) return;
      const current = getAppByLease(address, app.leaseUuid);
      if (observation && current && recoverySnapshotKey(current) === recoverySnapshotKey(observation.app)) {
        attempt.snapshot = recoverySnapshotKey(current);
        attempt.retired = observation.complete;
      }
      attempt.nextAttemptAt = Date.now() + AUTO_REFRESH_INTERVAL_MS * 2 ** (attempt.attempts - 1);
    } catch (error) {
      if (!abort.signal.aborted) {
        logError('useAppRecovery', error);
        attempt.nextAttemptAt = Date.now() + AUTO_REFRESH_INTERVAL_MS * 2 ** (attempt.attempts - 1);
      }
    } finally {
      // Foreground cancellation refunds the retry budget, but the interrupted
      // app still took a turn. Put it behind untouched/older eligible peers.
      if (abort.signal.aborted) {
        attempt.attempts--;
        attempt.nextAttemptAt = Date.now();
      }
      abort.abort();
      if (abortRef.current === abort) abortRef.current = null;
    }
  }, [address, store]);

  useVisibilityPolling(refresh, APP_RECOVERY_POLL_INTERVAL_MS, {
    enabled: !!address && !!store,
    immediate: true,
    context: 'useAppRecovery',
    restartKey: address,
  });
}
