/**
 * AppShell — top-level router.
 * Shows LandingPage when disconnected, MainLayout when connected.
 */

import { useEffect, useCallback } from 'react';
import { useChain } from '@cosmos-kit/react';
import { useAI } from '../../hooks/useAI';
import { useManifestMCP } from '../../hooks/useManifestMCP';
import { LandingPage } from '../landing/LandingPage';
import { MainLayout } from './MainLayout';
import { CHAIN_NAME } from '../../config/chain';

export function AppShell() {
  const { setClientManager, setAddress, setSignArbitrary } = useAI();
  const { clientManager, address } = useManifestMCP();
  const { signArbitrary, isWalletConnected, isWalletConnecting, openView } = useChain(CHAIN_NAME);

  // Create a stable wrapper for signArbitrary
  const wrappedSignArbitrary = useCallback(
    async (signerAddress: string, data: string) => {
      if (typeof signArbitrary !== 'function') {
        throw new Error('Wallet does not support signArbitrary');
      }
      const result = await signArbitrary(signerAddress, data);
      return {
        pub_key: result.pub_key,
        signature: result.signature,
      };
    },
    [signArbitrary]
  );

  // Sync wallet state with AI context
  useEffect(() => {
    setClientManager(clientManager);
    setAddress(address);
    const canSign = isWalletConnected && typeof signArbitrary === 'function';
    setSignArbitrary(canSign ? wrappedSignArbitrary : undefined);
  }, [clientManager, address, isWalletConnected, signArbitrary, setClientManager, setAddress, setSignArbitrary, wrappedSignArbitrary]);

  if (!isWalletConnected) {
    return <LandingPage onConnect={() => openView()} isConnecting={isWalletConnecting} />;
  }

  return <MainLayout />;
}
