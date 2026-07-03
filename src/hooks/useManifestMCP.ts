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
import { createAuthTokens } from '@manifest-network/manifest-sdk/deploy';
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

        // Build the ADR-036 auth-token factory bound to this wallet address.
        // Shares the mutex's sign lock so single + batch ops never hit the
        // wallet concurrently.
        const authSigner = createSignerAdapter(walletProvider, 'manifest');
        const authTokens = createAuthTokens(authSigner, { chainId: CHAIN_ID });
        const signingContext: SigningContext = { authTokens, withSign: mutex.withSign };

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
