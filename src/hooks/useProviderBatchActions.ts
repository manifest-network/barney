import { useCallback } from 'react';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import type { Lease } from '../api/billing';
import type { TxResult } from '../api/tx';
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

  /**
   * Creates a batch action handler that checks selection, executes a tx, then clears selection.
   */
  const makeBatchHandler = useCallback(
    (
      selection: UseBatchSelectionReturn,
      txFn: (signer: OfflineSigner, addr: string, uuids: string[], ...extra: string[]) => Promise<TxResult>,
      successLabel: (count: number, hash: string) => string,
    ) =>
      async (...extra: string[]) => {
        if (selection.selected.size === 0) return;
        const leaseUuids = Array.from(selection.selected);

        await executeTx(
          (signer) => txFn(signer, address!, leaseUuids, ...extra),
          {
            successMessage: (hash) => successLabel(leaseUuids.length, hash),
            onSuccess: async () => {
              selection.clear();
              await onSuccess();
            },
          },
        );
      },
    [executeTx, address, onSuccess],
  );

  const handleBatchAcknowledge = useCallback(
    () => makeBatchHandler(pending, acknowledgeLease, (n, hash) => `${n} lease(s) acknowledged! Tx: ${hash}...`)(),
    [makeBatchHandler, pending],
  );

  const handleBatchReject = useCallback(
    (reason: string) => makeBatchHandler(pending, rejectLease, (n, hash) => `${n} lease(s) rejected! Tx: ${hash}...`)(reason),
    [makeBatchHandler, pending],
  );

  const handleBatchWithdraw = useCallback(
    () => makeBatchHandler(active, withdrawFromLeases, (n, hash) => `Withdrawal from ${n} lease(s) successful! Tx: ${hash}...`)(),
    [makeBatchHandler, active],
  );

  const handleBatchClose = useCallback(
    (reason?: string) => makeBatchHandler(active, closeLease, (n, hash) => `${n} lease(s) closed! Tx: ${hash}...`)(reason ?? ''),
    [makeBatchHandler, active],
  );

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
