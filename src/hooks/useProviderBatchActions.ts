import { useCallback } from 'react';
import type { Lease } from '../api/billing';
import { acknowledgeLease, rejectLease, withdrawFromLeases, closeLease } from '../api/tx';
import type { TxHandler } from './useTxHandler';
import { useBatchSelection, type UseBatchSelectionReturn } from './useBatchSelection';

interface UseProviderBatchActionsOptions {
  address: string | undefined;
  executeTx: TxHandler['executeTx'];
  pendingLeases: Lease[];
  activeLeases: Lease[];
  onSuccess: () => Promise<void> | void;
}

interface UseProviderBatchActionsReturn {
  pending: UseBatchSelectionReturn;
  active: UseBatchSelectionReturn;
  selectAllPending: () => void;
  selectAllActive: () => void;
  handleBatchAcknowledge: () => Promise<void>;
  handleBatchReject: (reason: string) => Promise<void>;
  handleBatchWithdraw: () => Promise<void>;
  handleBatchClose: (reason?: string) => Promise<void>;
}

export function useProviderBatchActions({
  address,
  executeTx,
  pendingLeases,
  activeLeases,
  onSuccess,
}: UseProviderBatchActionsOptions): UseProviderBatchActionsReturn {
  const pending = useBatchSelection();
  const active = useBatchSelection();

  const selectAllPending = useCallback(
    () => pending.selectAll(pendingLeases.map((l) => l.uuid)),
    [pending, pendingLeases],
  );

  const selectAllActive = useCallback(
    () => active.selectAll(activeLeases.map((l) => l.uuid)),
    [active, activeLeases],
  );

  const handleBatchAcknowledge = useCallback(async () => {
    if (pending.selected.size === 0) return;
    const leaseUuids = Array.from(pending.selected);

    await executeTx(
      (signer) => acknowledgeLease(signer, address!, leaseUuids),
      {
        successMessage: (hash) => `${leaseUuids.length} lease(s) acknowledged! Tx: ${hash}...`,
        onSuccess: async () => {
          pending.clear();
          await onSuccess();
        },
      },
    );
  }, [pending, executeTx, address, onSuccess]);

  const handleBatchReject = useCallback(async (reason: string) => {
    if (pending.selected.size === 0) return;
    const leaseUuids = Array.from(pending.selected);

    await executeTx(
      (signer) => rejectLease(signer, address!, leaseUuids, reason),
      {
        successMessage: (hash) => `${leaseUuids.length} lease(s) rejected! Tx: ${hash}...`,
        onSuccess: async () => {
          pending.clear();
          await onSuccess();
        },
      },
    );
  }, [pending, executeTx, address, onSuccess]);

  const handleBatchWithdraw = useCallback(async () => {
    if (active.selected.size === 0) return;
    const leaseUuids = Array.from(active.selected);

    await executeTx(
      (signer) => withdrawFromLeases(signer, address!, leaseUuids),
      {
        successMessage: (hash) => `Withdrawal from ${leaseUuids.length} lease(s) successful! Tx: ${hash}...`,
        onSuccess: async () => {
          active.clear();
          await onSuccess();
        },
      },
    );
  }, [active, executeTx, address, onSuccess]);

  const handleBatchClose = useCallback(async (reason?: string) => {
    if (active.selected.size === 0) return;
    const leaseUuids = Array.from(active.selected);

    await executeTx(
      (signer) => closeLease(signer, address!, leaseUuids, reason),
      {
        successMessage: (hash) => `${leaseUuids.length} lease(s) closed! Tx: ${hash}...`,
        onSuccess: async () => {
          active.clear();
          await onSuccess();
        },
      },
    );
  }, [active, executeTx, address, onSuccess]);

  return {
    pending,
    active,
    selectAllPending,
    selectAllActive,
    handleBatchAcknowledge,
    handleBatchReject,
    handleBatchWithdraw,
    handleBatchClose,
  };
}
