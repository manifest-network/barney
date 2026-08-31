/**
 * Recurring chain-to-registry reconciliation.
 *
 * Mounted by MainLayout outside the sidebar ErrorBoundary so registry repair
 * survives a sidebar render failure. Lease lists provide the live state set;
 * custom domains come from authoritative single-lease reads rather than
 * assuming the list endpoint populated Lease.items. Every read has a deadline,
 * and per-lease reads use a bounded rotating fan-out.
 */

import { useCallback, useRef } from 'react';
import { getLeasesByTenant, LeaseState } from '../api/billing';
import { getLeaseItemsForLease } from '../api/leaseItems';
import { getDomainAssignments } from '../api/leaseDomains';
import { withTimeout } from '../api/utils';
import {
  getApps,
  reconcileCustomDomainsWithChain,
  reconcileWithChain,
  type CustomDomainChainObservation,
} from '../registry/appRegistry';
import { AI_TOOL_API_TIMEOUT_MS, AUTO_REFRESH_INTERVAL_MS } from '../config/constants';
import { logError } from '../utils/errors';
import { useVisibilityPolling } from './useVisibilityPolling';

/**
 * Bound total fan-out, not only simultaneous awaits. Larger registries rotate
 * through this many live leases per pass and still converge over later ticks.
 */
const LEASE_ITEM_READS_PER_PASS = 4;

export function useRegistryReconciliation(
  address: string | undefined,
): void {
  const leaseItemCursorByAddressRef = useRef(new Map<string, number>());

  const refresh = useCallback(async (): Promise<boolean | void> => {
    if (!address) return;

    try {
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
      );

      const leaseStates = new Map<string, 'active' | 'pending'>();
      for (const lease of pendingLeases) leaseStates.set(lease.uuid, 'pending');
      for (const lease of activeLeases) leaseStates.set(lease.uuid, 'active');
      reconcileWithChain(address, leaseStates, expectedChainStates);

      const liveRegisteredLeaseUuids = [...expectedDomains.keys()]
        .filter((leaseUuid) => leaseStates.has(leaseUuid));
      const cursor = leaseItemCursorByAddressRef.current.get(address) ?? 0;
      const readCount = Math.min(LEASE_ITEM_READS_PER_PASS, liveRegisteredLeaseUuids.length);
      const leaseUuidsForThisPass = Array.from({ length: readCount }, (_, offset) =>
        liveRegisteredLeaseUuids[(cursor + offset) % liveRegisteredLeaseUuids.length]
      );
      if (liveRegisteredLeaseUuids.length > 0) {
        leaseItemCursorByAddressRef.current.set(
          address,
          (cursor + readCount) % liveRegisteredLeaseUuids.length,
        );
      }
      const observations = new Map<string, CustomDomainChainObservation>();
      await Promise.all(
        leaseUuidsForThisPass.map(async (leaseUuid) => {
          try {
            const items = await withTimeout(
              getLeaseItemsForLease(leaseUuid),
              AI_TOOL_API_TIMEOUT_MS,
              `Registry lease-item refresh (${leaseUuid})`,
            );
            // The list observed this lease as live, but a single-lease read from
            // another/older RPC could still report not-found. That is uncertainty,
            // not an authoritative empty item set, so preserve the cache.
            if (items === null) return;
            observations.set(leaseUuid, {
              customDomains: getDomainAssignments(items),
              expectedLocalDomains: expectedDomains.get(leaseUuid),
            });
          } catch (error) {
            // A transient failure for one lease must not turn into an empty-domain
            // observation or prevent healthy leases from converging.
            logError('useRegistryReconciliation.leaseItems', error);
          }
        }),
      );
      reconcileCustomDomainsWithChain(address, observations);
    } catch (error) {
      logError('useRegistryReconciliation', error);
      return false;
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
