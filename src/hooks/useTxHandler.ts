import { useCallback, useState } from 'react';
import { useChain } from '@cosmos-kit/react';
import type { TxResult } from '../api/tx';
import { useToast } from './useToast';
import { CHAIN_NAME } from '../config/chain';
import { TX_HASH_DISPLAY_LENGTH } from '../config/constants';

/**
 * Return type for useTxHandler hook
 */
export interface TxHandler {
  /**
   * Whether a transaction is currently in progress
   */
  txLoading: boolean;

  /**
   * Execute a transaction with standardized error handling and toast notifications.
   *
   * @param txFn - Async function that performs the transaction
   * @param options - Configuration options
   * @returns The transaction result
   *
   * @example
   * const result = await executeTx(
   *   async (signer) => cancelLease(signer, address, [leaseUuid]),
   *   { successMessage: 'Lease cancelled!' }
   * );
   */
  executeTx: <T extends TxResult>(
    txFn: (signer: ReturnType<ReturnType<typeof useChain>['getOfflineSigner']>) => Promise<T>,
    options?: ExecuteTxOptions
  ) => Promise<T | null>;
}

/**
 * Options for executeTx
 */
export interface ExecuteTxOptions {
  /**
   * Message to show on success. If not provided, a generic message with tx hash is shown.
   * Use a function to include the tx hash: (hash) => `Done! Tx: ${hash}`
   */
  successMessage?: string | ((txHash: string) => string);

  /**
   * Prefix for error messages. Defaults to "Transaction failed"
   */
  errorPrefix?: string;

  /**
   * Callback to run after successful transaction (e.g., refetch data)
   */
  onSuccess?: () => void | Promise<void>;

  /**
   * Whether to show toast notifications. Defaults to true.
   */
  showToast?: boolean;
}

/**
 * Hook that provides standardized transaction handling with loading state,
 * error handling, and toast notifications.
 *
 * This hook centralizes the common transaction pattern:
 * - Check wallet connection
 * - Get offline signer
 * - Set loading state
 * - Execute transaction
 * - Show success/error toast
 * - Optionally refetch data
 *
 * @returns TxHandler with txLoading state and executeTx function
 *
 * @example
 * function MyComponent() {
 *   const { txLoading, executeTx } = useTxHandler();
 *
 *   const handleCancel = async (leaseUuid: string) => {
 *     await executeTx(
 *       (signer) => cancelLease(signer, address, [leaseUuid]),
 *       {
 *         successMessage: 'Lease cancelled!',
 *         onSuccess: fetchData,
 *       }
 *     );
 *   };
 *
 *   return <button disabled={txLoading} onClick={() => handleCancel(uuid)}>Cancel</button>;
 * }
 */
export function useTxHandler(): TxHandler {
  const { address, getOfflineSigner } = useChain(CHAIN_NAME);
  const toast = useToast();
  const [txLoading, setTxLoading] = useState(false);

  const executeTx = useCallback(
    async <T extends TxResult>(
      txFn: (signer: ReturnType<typeof getOfflineSigner>) => Promise<T>,
      options?: ExecuteTxOptions
    ): Promise<T | null> => {
      if (!address) {
        if (options?.showToast !== false) {
          toast.error('Please connect your wallet');
        }
        return null;
      }

      try {
        const signer = getOfflineSigner();
        setTxLoading(true);

        const result = await txFn(signer);

        if (options?.showToast !== false) {
          if (result.success) {
            const txHashDisplay = result.transactionHash?.slice(0, TX_HASH_DISPLAY_LENGTH) ?? '';
            const message =
              typeof options?.successMessage === 'function'
                ? options.successMessage(txHashDisplay)
                : options?.successMessage ?? `Transaction successful! Tx: ${txHashDisplay}...`;
            toast.success(message);
          } else {
            const prefix = options?.errorPrefix ?? 'Transaction failed';
            toast.error(`${prefix}: ${result.error}`);
          }
        }

        if (result.success && options?.onSuccess) {
          await options.onSuccess();
        }

        return result;
      } catch (err) {
        if (options?.showToast !== false) {
          const prefix = options?.errorPrefix ?? 'Error';
          toast.error(`${prefix}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
        return null;
      } finally {
        setTxLoading(false);
      }
    },
    [address, getOfflineSigner, toast]
  );

  return { txLoading, executeTx };
}
