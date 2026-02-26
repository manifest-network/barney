/**
 * AppShell — top-level router.
 * Shows LandingPage when disconnected, MainLayout when connected.
 * Transitions between views with a fade + slide animation.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useChain } from '@cosmos-kit/react';
import { useAI } from '../../hooks/useAI';
import { useManifestMCP } from '../../hooks/useManifestMCP';
import { useToast } from '../../hooks/useToast';
import { useAutoRefill } from '../../hooks/useAutoRefill';
import { LandingPage } from '../landing/LandingPage';
import { MainLayout } from './MainLayout';
import { AccountSetupOverlay } from './AccountSetupOverlay';
import { logError } from '../../utils/errors';
import { CHAIN_NAME } from '../../config/chain';

const EXIT_DURATION_MS = 150;

function isPopupBlockedError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('popup was blocked') || lower.includes('popup_window');
}

function isPopupClosedError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('popup has been closed') || lower.includes('user closed');
}

export function AppShell() {
  const { setClientManager, setAddress, setSignArbitrary } = useAI();
  const { clientManager, address } = useManifestMCP();
  const { signArbitrary, isWalletConnected, isWalletConnecting, openView, getOfflineSigner, status, message, disconnect } = useChain(CHAIN_NAME);

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

  // Auto-refill: faucet + credit funding (immediate on connect, then recurring)
  const toast = useToast();
  // Ref avoids unstable getOfflineSigner closure in useEffect deps (same pattern as useManifestMCP)
  const getOfflineSignerRef = useRef(getOfflineSigner);
  useEffect(() => { getOfflineSignerRef.current = getOfflineSigner; }, [getOfflineSigner]);

  // Watch for wallet connection errors (e.g. Safari popup blocking)
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (status === prev) return;

    if (status === 'Error' || status === 'Rejected') {
      const errorMsg = message ?? 'Connection failed';
      logError('AppShell.walletConnect', errorMsg);

      if (isPopupBlockedError(errorMsg)) {
        toast.warning(
          'Pop-up blocked by your browser. Please allow pop-ups for this site and try again.',
          8000
        );
      } else if (isPopupClosedError(errorMsg)) {
        toast.info('Login cancelled.');
      } else {
        toast.error(`Connection failed: ${errorMsg}`);
      }

      // Reset cosmos-kit back to Disconnected so user can retry
      disconnect();
    }
  }, [status, message, disconnect, toast]);

  const setupState = useAutoRefill({ address, isWalletConnected, getOfflineSignerRef, toast });

  // Page transition: defer content swap until exit animation completes.
  // `exiting` is derived (not state) so we avoid calling setState in the effect body.
  const [renderedConnected, setRenderedConnected] = useState(isWalletConnected);
  const exiting = isWalletConnected !== renderedConnected;

  useEffect(() => {
    if (isWalletConnected === renderedConnected) return;
    const timer = setTimeout(() => {
      setRenderedConnected(isWalletConnected);
    }, EXIT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [isWalletConnected, renderedConnected]);

  return (
    <>
      <AccountSetupOverlay state={setupState} />
      <div className={`app-shell__page ${exiting ? 'app-shell__page--exit' : ''}`}>
        {renderedConnected
          ? <MainLayout />
          : <LandingPage onConnect={() => openView()} isConnecting={isWalletConnecting} />
        }
      </div>
    </>
  );
}
