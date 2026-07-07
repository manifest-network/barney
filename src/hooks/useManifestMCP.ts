/**
 * Hook to integrate cosmos-kit with @manifest-network/manifest-mcp-core
 */

import { useEffect, useRef, useState } from 'react';
import { useChain } from '@cosmos-kit/react';
import {
  CosmosClientManager,
  createSignerAdapter,
  type ManifestMCPConfig,
  type WalletProvider,
  type SignArbitraryResult,
} from '@manifest-network/manifest-sdk';
// ADR-036 D3: createProviderAuth is not re-exported on the @manifest-network/manifest-sdk
// facade yet (ENG follow-up filed) — import from manifest-mcp-fred directly.
import { createProviderAuth } from '@manifest-network/manifest-mcp-fred';
import { createAuthTokensAdapter } from './authTokensAdapter';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import { RPC_ENDPOINT } from '../api/config';
import { CHAIN_NAME, CHAIN_ID, GAS_PRICE } from '../config/chain';
import { createSigningMutex } from '../ai/toolExecutor/batchRunner';
import type { SigningContext } from '../ai/toolExecutor/types';
import { logError } from '../utils/errors';

/**
 * Custom WalletProvider that wraps cosmos-kit's signer
 */
class CosmosKitWalletProvider implements WalletProvider {
  readonly type = 'web3auth' as const;
  private signer: OfflineSigner;
  private address: string;
  signArbitrary?: (address: string, data: string) => Promise<SignArbitraryResult>;

  constructor(
    signer: OfflineSigner,
    address: string,
    signArbitrary?: (address: string, data: string) => Promise<SignArbitraryResult>,
  ) {
    this.signer = signer;
    this.address = address;
    this.signArbitrary = signArbitrary;
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async getSigner(): Promise<OfflineSigner> {
    return this.signer;
  }
}

export interface UseManifestMCPResult {
  clientManager: CosmosClientManager | null;
  signing: SigningContext | undefined;
  isConnected: boolean;
  address: string | undefined;
  error: string | null;
}

/**
 * Hook to get a CosmosClientManager connected via cosmos-kit
 */
export function useManifestMCP(): UseManifestMCPResult {
  const { address, isWalletConnected, getOfflineSigner, signArbitrary } = useChain(CHAIN_NAME);
  const [clientManager, setClientManager] = useState<CosmosClientManager | null>(null);
  const [signing, setSigning] = useState<SigningContext | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const clientManagerRef = useRef<CosmosClientManager | null>(null);
  const getOfflineSignerRef = useRef(getOfflineSigner);
  const signArbitraryRef = useRef(signArbitrary);

  useEffect(() => {
    getOfflineSignerRef.current = getOfflineSigner;
  }, [getOfflineSigner]);

  useEffect(() => {
    signArbitraryRef.current = signArbitrary;
  }, [signArbitrary]);

  useEffect(() => {
    let isMounted = true;

    const initClientManager = async () => {
      if (!isWalletConnected || !address) {
        if (clientManagerRef.current) {
          clientManagerRef.current.disconnect();
          clientManagerRef.current = null;
        }
        if (isMounted) {
          setClientManager(null);
          setSigning(undefined);
          setError(null);
        }
        return;
      }

      try {
        const signer = getOfflineSignerRef.current();

        // Bridge cosmos-kit's signArbitrary into the SDK WalletProvider shape.
        const wrappedSignArbitrary = async (
          signerAddress: string,
          data: string,
        ): Promise<SignArbitraryResult> => {
          const fn = signArbitraryRef.current;
          if (typeof fn !== 'function') {
            throw new Error('Wallet does not support signArbitrary');
          }
          const result = await fn(signerAddress, data);
          return { pub_key: result.pub_key, signature: result.signature };
        };
        const mutex = createSigningMutex(wrappedSignArbitrary);
        const walletProvider = new CosmosKitWalletProvider(
          signer,
          address,
          mutex.signArbitraryWithMutex,
        );

        const config: ManifestMCPConfig = {
          chainId: CHAIN_ID,
          rpcUrl: RPC_ENDPOINT,
          gasPrice: GAS_PRICE,
          addressPrefix: 'manifest',
        };

        // Disconnect existing client if any
        if (clientManagerRef.current) {
          clientManagerRef.current.disconnect();
        }

        // Get or create the singleton instance
        const manager = CosmosClientManager.getInstance(config, walletProvider);
        clientManagerRef.current = manager;

        // Only expose `signing` when the wallet can sign arbitrary data, so a
        // wallet that can't is gated at the executor's `!signing` check before
        // any billed action (e.g. create-lease). clientManager is still set —
        // chain TXs + queries work either way. Restores main's `canSign` gate
        // that the SDK migration dropped (ENG-466 / Copilot PR #104).
        //
        // NOTE: cosmos-kit's useChain always returns `signArbitrary` as a thin
        // wrapper that throws at CALL time (never literally undefined), so this
        // `typeof` check is effectively always true for the enabled Web3Auth
        // wallet — same as main, where `canSign` reduced to `isWalletConnected`.
        // So this is defensive parity (inert for cosmos-kit), not a behavior
        // change. It reads the ref rather than adding signArbitrary to the
        // effect deps on purpose: cosmos-kit hands back a fresh wrapper identity
        // per render, which would thrash the client re-init. A real pre-lease
        // fast-fail for a wallet whose underlying client lacks signArbitrary
        // must probe `wallet.client.signArbitrary` — tracked in ENG-466.
        // The factory shares the mutex's sign lock so single + batch ops never
        // hit the wallet concurrently.
        const canSign = typeof signArbitraryRef.current === 'function';
        const signingContext: SigningContext | undefined = canSign
          ? (() => {
              // ONE ADR-036 minter (one AuthTimestampTracker). authTokens is a thin
              // address-binding adapter over THIS instance — never a 2nd
              // createProviderAuth (D2 same-lease/same-second replay guard).
              const providerAuth = createProviderAuth(
                createSignerAdapter(walletProvider, 'manifest'),
                { chainId: CHAIN_ID },
              );
              return {
                providerAuth,
                authTokens: createAuthTokensAdapter(providerAuth, address),
                withSign: mutex.withSign,
              };
            })()
          : undefined;

        if (isMounted) {
          setClientManager(manager);
          setSigning(signingContext);
          setError(null);
        }
      } catch (err) {
        logError('useManifestMCP.initClientManager', err);
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to connect');
          setClientManager(null);
          setSigning(undefined);
        }
      }
    };

    initClientManager();

    return () => {
      isMounted = false;
    };
  }, [isWalletConnected, address]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (clientManagerRef.current) {
        clientManagerRef.current.disconnect();
        clientManagerRef.current = null;
      }
    };
  }, []);

  return {
    clientManager,
    signing,
    isConnected: isWalletConnected && clientManager !== null,
    address,
    error,
  };
}
