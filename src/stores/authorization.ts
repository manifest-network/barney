import type { TransactionAuthorization } from '../ai/toolExecutor/types';
import type { CosmosClientManager } from '@manifest-network/manifest-sdk';

export const AUTHORIZATION_CANCELLED_MESSAGE =
  'Wallet or network changed. This transaction was cancelled and was not submitted.';

export const ACTIVE_WORK_CANCELLED_MESSAGE =
  'Wallet or network changed. Active AI work was cancelled.';

export const TRANSACTION_INTERRUPTED_MESSAGE =
  'Wallet or network changed while this transaction was in progress. It may already have been submitted; check its status before retrying.';

/** Phrased relative to the EVENT, not to whoever is looking. The row this
 * lands on lives in the originating wallet's own transcript, and the reader may
 * well be that wallet again (switched back, or only the signer instance was
 * refreshed) — so it must not assert that some other wallet is now active. */
export const TRANSACTION_FINISHED_AFTER_CONTEXT_CHANGE_MESSAGE =
  'This transaction finished after the wallet or network changed.';

/** Minimal state needed to capture and validate a transaction authorization. */
export interface AuthorizationState {
  address: string | undefined;
  chainId: string;
  clientManager: CosmosClientManager | null;
  clientGeneration: number;
  signerGeneration: number;
}

export function captureTransactionAuthorization(
  state: AuthorizationState,
): TransactionAuthorization | null {
  if (!state.address || !state.clientManager) return null;
  return Object.freeze({
    originAddress: state.address,
    chainId: state.chainId,
    clientGeneration: state.clientGeneration,
    signerGeneration: state.signerGeneration,
  });
}

export function isTransactionAuthorizationCurrent(
  state: AuthorizationState,
  authorization: TransactionAuthorization,
): boolean {
  return !!state.clientManager
    && state.address === authorization.originAddress
    && state.chainId === authorization.chainId
    && state.clientGeneration === authorization.clientGeneration
    && state.signerGeneration === authorization.signerGeneration;
}

export function assertTransactionAuthorizationCurrent(
  state: AuthorizationState,
  authorization: TransactionAuthorization,
): void {
  if (!isTransactionAuthorizationCurrent(state, authorization)) {
    throw new Error(AUTHORIZATION_CANCELLED_MESSAGE);
  }
}
