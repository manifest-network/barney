import type { TransactionAuthorization } from '../ai/toolExecutor/types';

export const AUTHORIZATION_CANCELLED_MESSAGE =
  'Wallet or network changed. This transaction was cancelled and was not submitted.';

export const ACTIVE_WORK_CANCELLED_MESSAGE =
  'Wallet or network changed. Active AI and transaction work was cancelled.';

export const AUTHORIZATION_CHANGED_ERROR = 'authorization_context_changed';

/** Minimal state needed to capture and validate a transaction authorization. */
export interface AuthorizationState {
  address: string | undefined;
  chainId: string;
  clientManager: unknown | null;
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
