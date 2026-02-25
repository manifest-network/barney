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
import { LandingPage } from '../landing/LandingPage';
import { MainLayout } from './MainLayout';
import { CHAIN_NAME } from '../../config/chain';
import { getBalance } from '../../api/bank';
import { requestFaucetTokens, isFaucetEnabled } from '../../api/faucet';
import { fundCredit } from '../../api/tx';
import { DENOMS } from '../../api/config';
import { toBaseUnits } from '../../utils/format';
import { logError } from '../../utils/errors';

const EXIT_DURATION_MS = 150;

export function AppShell() {
  const { setClientManager, setAddress, setSignArbitrary } = useAI();
  const { clientManager, address } = useManifestMCP();
  const { signArbitrary, isWalletConnected, isWalletConnecting, openView, getOfflineSigner } = useChain(CHAIN_NAME);

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

  // Auto-faucet: request tokens for new wallets with zero balance
  const toast = useToast();
  const faucetRequestedRef = useRef<string | null>(null);
  // Ref avoids unstable getOfflineSigner closure in useEffect deps (same pattern as useManifestMCP)
  const getOfflineSignerRef = useRef(getOfflineSigner);
  useEffect(() => { getOfflineSignerRef.current = getOfflineSigner; }, [getOfflineSigner]);

  useEffect(() => {
    if (!isFaucetEnabled() || !isWalletConnected || !address) return;
    if (faucetRequestedRef.current === address) return;
    faucetRequestedRef.current = address;

    const targetAddress = address;
    (async () => {
      try {
        const { amount } = await getBalance(targetAddress, DENOMS.MFX);
        if (amount !== '0') return; // returning user

        toast.info('Sending free MFX and PWR tokens to your wallet…');
        const { results } = await requestFaucetTokens(targetAddress);
        // Skip toast if address changed during the async request
        if (faucetRequestedRef.current !== targetAddress) return;
        const allSuccess = results.every((r) => r.success);
        const allFailed = results.every((r) => !r.success);
        if (allSuccess) {
          toast.success('Welcome! Free MFX and PWR tokens have been sent to your wallet.');
        } else if (allFailed) {
          toast.info('Welcome! No tokens could be sent — the 24h cooldown may be active.');
        } else {
          toast.info('Welcome! Some tokens could not be sent — the 24h cooldown may be active.');
        }

        // Auto-fund credit account if the faucet sent PWR
        const pwrDrip = results.find((r) => r.denom === DENOMS.PWR);
        if (pwrDrip?.success) {
          const AUTO_FUND_AMOUNT = 10;
          try {
            const signer = getOfflineSignerRef.current();
            const result = await fundCredit(signer, targetAddress, targetAddress, {
              denom: DENOMS.PWR,
              amount: toBaseUnits(AUTO_FUND_AMOUNT, DENOMS.PWR),
            });
            if (faucetRequestedRef.current !== targetAddress) return;
            if (result.success) {
              toast.success(`Funded ${AUTO_FUND_AMOUNT} credits — you're all set!`);
            } else {
              logError('AppShell.autoFundCredits', result.error);
              toast.info('Tokens received, but auto-funding credits failed. You can fund credits manually.');
            }
          } catch (error) {
            logError('AppShell.autoFundCredits', error);
            toast.info('Tokens received, but auto-funding credits failed. You can fund credits manually.');
          }
        }
      } catch (error) {
        logError('AppShell.autoFaucet', error);
      }
    })();
  }, [isWalletConnected, address, toast]);

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
    <div className={`app-shell__page ${exiting ? 'app-shell__page--exit' : ''}`}>
      {renderedConnected
        ? <MainLayout />
        : <LandingPage onConnect={() => openView()} isConnecting={isWalletConnecting} />
      }
    </div>
  );
}
