/**
 * AppShell — top-level router.
 * Shows LandingPage when disconnected, MainLayout when connected.
 * Transitions between views with a fade + slide animation.
 */

import { useState, useEffect, useLayoutEffect, useRef, lazy, Suspense } from 'react';
import { useChain } from '@cosmos-kit/react';
import { useAI } from '../../hooks/useAI';
import { useManifestMCP } from '../../hooks/useManifestMCP';
import { useToast } from '../../hooks/useToast';
import { useAccountSetup } from '../../hooks/useAccountSetup';
import { AccountSetupOverlay } from './AccountSetupOverlay';
import { logError } from '../../utils/errors';
import { CHAIN_ID, CHAIN_NAME } from '../../config/chain';
import { invalidateReservedDomainSuffixesCache } from '../../api/billingParams';
import { invalidateMorpheusSession, logoutMorpheusSession } from '../../api/morpheusSession';

const LandingPage = lazy(() =>
  import('../landing/LandingPage').then(m => ({ default: m.LandingPage }))
);
const MainLayout = lazy(() =>
  import('./MainLayout').then(m => ({ default: m.MainLayout }))
);

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
  const { setWalletContext } = useAI();
  const {
    clientManager,
    clientAddress,
    address,
    signing,
    isConnected: isManifestConnected,
  } = useManifestMCP();
  const { isWalletConnected, isWalletConnecting, openView, status, message, disconnect } = useChain(CHAIN_NAME);
  const toast = useToast();
  const contextMatchesAddress = isManifestConnected && clientAddress === address;
  const activeClientManager = contextMatchesAddress ? clientManager : null;
  const activeSigning = contextMatchesAddress ? signing : undefined;

  // Account-setup funding needs the signing CosmosClientManager (the same
  // aiStore singleton wired below). Never expose an old address's manager
  // during the transition; useAccountSetup reads this ref lazily at funding time.
  const clientManagerRef = useRef(activeClientManager);
  useLayoutEffect(() => { clientManagerRef.current = activeClientManager; }, [activeClientManager]);

  // Invalidate chain-scoped caches when the connected address changes (different
  // wallet, possibly different chain → different governance Params).
  useEffect(() => {
    invalidateReservedDomainSuffixesCache();
  }, [address]);

  // A relay session is wallet-bound. Explicit disconnects and wallet switches
  // revoke the old HttpOnly session before the next inference request can mint
  // one for the new address.
  const previousRelayAddressRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previousAddress = previousRelayAddressRef.current;
    previousRelayAddressRef.current = address;
    if (previousAddress === address) return;
    invalidateMorpheusSession();
    if (previousAddress) {
      void logoutMorpheusSession().catch((error) => {
        logError('AppShell.morpheusLogout', error);
      });
    }
  }, [address]);

  // Sync wallet state with AI context. Layout timing prevents a confirmation
  // for the prior wallet from surviving into a painted frame that already
  // displays the next wallet.
  useLayoutEffect(() => {
    setWalletContext({
      clientManager: activeClientManager,
      address,
      signing: activeSigning,
      chainId: CHAIN_ID,
    });
  }, [activeClientManager, address, activeSigning, setWalletContext]);

  // Watch for wallet connection errors (e.g. Safari popup blocking)
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (status === prev) return;

    if (status === 'Error' || status === 'Rejected') {
      const errorMsg = message || 'Connection failed';
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
      disconnect().catch(err => logError('AppShell.disconnect', err));
    }
  }, [status, message, disconnect, toast]);

  const setupState = useAccountSetup({ address, isWalletConnected, clientManagerRef });

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
        <Suspense fallback={null}>
          {renderedConnected
            ? <MainLayout />
            : <LandingPage onConnect={() => openView()} isConnecting={isWalletConnecting} />
          }
        </Suspense>
      </div>
    </>
  );
}
