export interface WalletIdentity {
  chainId: string;
  address: string;
}

/** Build the stable identity used for wallet-scoped browser state. */
export function createWalletIdentity(
  chainId: string,
  address: string | undefined,
): WalletIdentity | null {
  const normalizedChainId = chainId.trim();
  const normalizedAddress = address?.trim().toLowerCase() ?? '';

  if (!normalizedChainId || !normalizedAddress) return null;

  return {
    chainId: normalizedChainId,
    address: normalizedAddress,
  };
}

export function walletIdentitiesEqual(
  left: WalletIdentity | null,
  right: WalletIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.chainId === right.chainId && left.address === right.address;
}

export function walletIdentityMatches(
  identity: WalletIdentity | null,
  chainId: string,
  address: string | undefined,
): boolean {
  return walletIdentitiesEqual(identity, createWalletIdentity(chainId, address))
    && identity !== null;
}
