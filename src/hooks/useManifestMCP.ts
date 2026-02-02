/**
 * Hook to integrate cosmos-kit with @manifest-network/manifest-mcp-browser
 */

import { useEffect, useRef, useState } from 'react';
import { useChain } from '@cosmos-kit/react';
import {
  CosmosClientManager,
  type ManifestMCPConfig,
  type WalletProvider,
} from '@manifest-network/manifest-mcp-browser';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import { RPC_ENDPOINT } from '../api/config';
import { CHAIN_NAME } from '../config/chain';

/**
 * Custom WalletProvider that wraps cosmos-kit's signer
 */
class CosmosKitWalletProvider implements WalletProvider {
  readonly type = 'keplr' as const;
  private signer: OfflineSigner;
  private address: string;

  constructor(signer: OfflineSigner, address: string) {
    this.signer = signer;
    this.address = address;
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
  isConnected: boolean;
  address: string | undefined;
  error: string | null;
}

/**
 * Hook to get a CosmosClientManager connected via cosmos-kit
 */
export function useManifestMCP(): UseManifestMCPResult {
  const { address, isWalletConnected, getOfflineSigner } = useChain(CHAIN_NAME);
  const [clientManager, setClientManager] = useState<CosmosClientManager | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientManagerRef = useRef<CosmosClientManager | null>(null);
  const getOfflineSignerRef = useRef(getOfflineSigner);

  useEffect(() => {
    getOfflineSignerRef.current = getOfflineSigner;
  }, [getOfflineSigner]);

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
          setError(null);
        }
        return;
      }

      try {
        const signer = getOfflineSignerRef.current();
        const walletProvider = new CosmosKitWalletProvider(signer, address);

        const config: ManifestMCPConfig = {
          chainId: 'manifest-ledger-beta',
          rpcUrl: RPC_ENDPOINT,
          gasPrice: '0.0umfx',
          addressPrefix: 'manifest',
        };

        // Disconnect existing client if any
        if (clientManagerRef.current) {
          clientManagerRef.current.disconnect();
        }

        // Get or create the singleton instance
        const manager = CosmosClientManager.getInstance(config, walletProvider);
        clientManagerRef.current = manager;

        if (isMounted) {
          setClientManager(manager);
          setError(null);
        }
      } catch (err) {
        console.error('Failed to initialize CosmosClientManager:', err);
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to connect');
          setClientManager(null);
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
    isConnected: isWalletConnected && clientManager !== null,
    address,
    error,
  };
}
