/**
 * Recurring chain-to-registry reconciliation.
 *
 * Mounted by MainLayout outside the sidebar ErrorBoundary so registry repair
 * survives a sidebar render failure. The tenant lease-list responses provide
 * both the live state set and each lease's items/custom domains. One deadline
 * covers the entire chain/catalog pass. Provider recovery has its own driver
 * so slow provider reads cannot delay chain or domain observations.
 */

import { useCallback, useContext, useEffect, useRef } from 'react';
import { getLeasesByTenant, LeaseState } from '../api/billing';
import { discoverTenantApps } from '../api/appDiscovery';
import { getDomainAssignments } from '../api/leaseDomains';
import { throwIfAborted, withTimeout } from '../api/utils';
import { AIStoreContext } from '../contexts/aiStoreContext';
import {
  getApps,
  reconcileCustomDomainsWithChain,
  reconcileWithChain,
  type CustomDomainChainObservation,
} from '../registry/appRegistry';
import { AI_TOOL_API_TIMEOUT_MS, AUTO_REFRESH_INTERVAL_MS } from '../config/constants';
import { logError } from '../utils/errors';
import { useVisibilityPolling } from './useVisibilityPolling';

export function useRegistryReconciliation(
  address: string | undefined,
): void {
  const store = useContext(AIStoreContext);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const unsubscribe = store?.subscribe((next, previous) => {
      if (next.authorizationEpoch !== previous.authorizationEpoch) abortRef.current?.abort();
    });
    return () => {
      abortRef.current?.abort();
      unsubscribe?.();
    };
  }, [address, store]);

  const refresh = useCallback(async (): Promise<boolean | void> => {
    if (!address) return;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    const { signal } = abort;

    const reconcile = async () => {
      // Capture both optimistic-concurrency baselines before any chain read.
      // If a confirmed transaction updates the registry while these RPCs are
      // in flight, the reconcilers reject the older snapshot.
      // Read the durable registry directly: chainState-only refreshes persist
      // without notifying UI subscribers, so a rendered apps prop can be stale.
      const registrySnapshot = getApps(address);
      const expectedDomains = new Map(
        registrySnapshot.map((app) => [app.leaseUuid, app.customDomains] as const),
      );
      const expectedChainStates = new Map(
        registrySnapshot.map((app) => [app.leaseUuid, app.chainState] as const),
      );
      const [activeLeases, pendingLeases] = await withTimeout(
        Promise.all([
          getLeasesByTenant(address, LeaseState.LEASE_STATE_ACTIVE),
          getLeasesByTenant(address, LeaseState.LEASE_STATE_PENDING),
        ]),
        AI_TOOL_API_TIMEOUT_MS,
        'Registry lease-state refresh',
        signal,
      );
      throwIfAborted(signal, 'Registry refresh');

      const leaseStates = new Map<string, 'active' | 'pending'>();
      for (const lease of pendingLeases) leaseStates.set(lease.uuid, 'pending');
      for (const lease of activeLeases) leaseStates.set(lease.uuid, 'active');
      reconcileWithChain(address, leaseStates, expectedChainStates);

      // manifestjs returns Lease.items on tenant-list reads just as it does on
      // getLease. Reuse those authoritative list payloads instead of issuing
      // one redundant RPC per registered lease on every polling pass.
      const liveLeases = new Map(
        [...pendingLeases, ...activeLeases].map((lease) => [lease.uuid, lease] as const),
      );
      const observations = new Map<string, CustomDomainChainObservation>();
      for (const [leaseUuid, expectedLocalDomains] of expectedDomains) {
        const lease = liveLeases.get(leaseUuid);
        if (!lease) continue;
        observations.set(leaseUuid, {
          customDomains: getDomainAssignments(lease.items),
          expectedLocalDomains,
        });
      }
      reconcileCustomDomainsWithChain(address, observations);
      await discoverTenantApps(address, [...liveLeases.values()], { signal });
      throwIfAborted(signal, 'Registry discovery');
    };

    try {
      await withTimeout(reconcile(), AI_TOOL_API_TIMEOUT_MS, 'Registry refresh', signal);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      logError('useRegistryReconciliation', error);
      return false;
    } finally {
      abort.abort();
    }
  }, [address]);

  useVisibilityPolling(refresh, AUTO_REFRESH_INTERVAL_MS, {
    enabled: !!address,
    immediate: true,
    backoff: true,
    context: 'useRegistryReconciliation',
    restartKey: address,
  });
}
