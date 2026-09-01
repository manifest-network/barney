/**
 * Recurring chain-to-registry reconciliation.
 *
 * Mounted by MainLayout outside the sidebar ErrorBoundary so registry repair
 * survives a sidebar render failure. The tenant lease-list responses provide
 * both the live state set and each lease's items/custom domains. The paired
 * list read has a deadline so one stalled RPC cannot pin the polling loop.
 */

import { useCallback } from 'react';
import { getLeasesByTenant, LeaseState } from '../api/billing';
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

export function useRegistryReconciliation(
  address: string | undefined,
): void {
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
