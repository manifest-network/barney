/**
 * AI Assistant wrapper component
 * Connects the AI context with cosmos-kit wallet
 */

import { useEffect, useCallback } from 'react';
import { useChain } from '@cosmos-kit/react';
import { useAI } from '../../contexts/AIContext';
import { useManifestMCP } from '../../hooks/useManifestMCP';
import { ChatBubble } from './ChatBubble';

const CHAIN_NAME = 'manifestlocal';

export function AIAssistant() {
  const { setClientManager, setAddress, setSignArbitrary } = useAI();
  const { clientManager, address } = useManifestMCP();
  const { signArbitrary, isWalletConnected } = useChain(CHAIN_NAME);

  // Create a stable wrapper for signArbitrary that matches the expected signature
  // Only create if signArbitrary is actually available (some wallets don't support it)
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
    // Only set signArbitrary if wallet is connected AND signArbitrary is available
    const canSign = isWalletConnected && typeof signArbitrary === 'function';
    setSignArbitrary(canSign ? wrappedSignArbitrary : undefined);
  }, [clientManager, address, isWalletConnected, signArbitrary, setClientManager, setAddress, setSignArbitrary, wrappedSignArbitrary]);

  return <ChatBubble />;
}
