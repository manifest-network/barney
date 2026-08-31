/**
 * Recurring chain-to-registry reconciliation.
 *
 * Mounted by MainLayout outside the sidebar ErrorBoundary so registry repair
 * survives a sidebar render failure. Lease lists provide the live state set;
 * custom domains come from authoritative single-lease reads rather than
 * assuming the list endpoint populated Lease.items.
 */

import { useCallback, useEffect, useRef } from 'react';
import { getLeasesByTenant, LeaseState } from '../api/billing';
import { getLeaseItemsForLease } from '../api/leaseItems';
import { getDomainAssignments } from '../api/leaseDomains';
import {
  reconcileCustomDomainsWithChain,
  reconcileWithChain,
  type AppEntry,
  type CustomDomainChainObservation,
} from '../registry/appRegistry';
import { AUTO_REFRESH_INTERVAL_MS } from '../config/constants';
import { logError } from '../utils/errors';
import { useVisibilityPolling } from './useVisibilityPolling';

export function useRegistryReconciliation(
  address: string | undefined,
  apps: readonly AppEntry[],
): void {
  const appsRef = useRef(apps);
  useEffect(() => { appsRef.current = apps; }, [apps]);

  const refresh = useCallback(async (): Promise<boolean | void> => {
    if (!address) return;

    try {
      // Capture the optimistic-concurrency baseline before either chain read.
      // If a confirmed transaction updates a domain while these RPCs are in
      // flight, the reconciler will see the mismatch and reject this snapshot.
      const expectedDomains = new Map(
        appsRef.current.map((app) => [app.leaseUuid, app.customDomains] as const),
      );
      const [activeLeases, pendingLeases] = await Promise.all([
        getLeasesByTenant(address, LeaseState.LEASE_STATE_ACTIVE),
        getLeasesByTenant(address, LeaseState.LEASE_STATE_PENDING),
      ]);

      const leaseStates = new Map<string, 'active' | 'pending'>();
      for (const lease of pendingLeases) leaseStates.set(lease.uuid, 'pending');
      for (const lease of activeLeases) leaseStates.set(lease.uuid, 'active');
      reconcileWithChain(address, leaseStates);

      const liveRegisteredLeaseUuids = [...expectedDomains.keys()]
        .filter((leaseUuid) => leaseStates.has(leaseUuid));
      const observations = new Map<string, CustomDomainChainObservation>();
      await Promise.all(liveRegisteredLeaseUuids.map(async (leaseUuid) => {
        try {
          const items = await getLeaseItemsForLease(leaseUuid);
          observations.set(leaseUuid, {
            customDomains: getDomainAssignments(items),
            expectedLocalDomains: expectedDomains.get(leaseUuid),
          });
        } catch (error) {
          // A transient failure for one lease must not turn into an empty-domain
          // observation or prevent healthy leases from converging.
          logError('useRegistryReconciliation.leaseItems', error);
        }
      }));
      reconcileCustomDomainsWithChain(address, observations);
    } catch (error) {
      logError('useRegistryReconciliation', error);
      return false;
    }
  }, [address]);

  useVisibilityPolling(refresh, AUTO_REFRESH_INTERVAL_MS, {
    enabled: !!address,
    immediate: false,
    backoff: true,
    context: 'useRegistryReconciliation',
  });

  // Fetch immediately on mount and wallet changes. The polling hook deliberately
  // does not restart when only its callback ref changes.
  useEffect(() => {
    void refresh();
  }, [refresh]);
}
