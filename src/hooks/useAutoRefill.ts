/**
 * useAutoRefill — recurring faucet + credit fund hook.
 *
 * Supersedes the one-shot first-login faucet that was previously inline in AppShell.
 * Unlike the old approach (which fired once for zero-balance wallets), this hook
 * monitors MFX, PWR, and credit balances on a recurring interval and automatically
 * requests faucet tokens or funds credits whenever balances drop below configured
 * thresholds. Cooldown timers prevent excessive requests.
 *
 * Gated entirely by isFaucetEnabled() — deployments without a faucet are unaffected.
 */

import { useEffect, useRef } from 'react';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import { getBalance } from '../api/bank';
import { getCreditAccount } from '../api/billing';
import { DENOMS } from '../api/config';
import { requestFaucetTokens, isFaucetEnabled } from '../api/faucet';
import { fundCredit } from '../api/tx';
import { fromBaseUnits, toBaseUnits } from '../utils/format';
import { logError } from '../utils/errors';
import type { ToastContextType } from '../contexts/ToastContext';
import {
  AUTO_REFILL_CHECK_INTERVAL_MS,
  AUTO_REFILL_MFX_THRESHOLD,
  AUTO_REFILL_PWR_WALLET_THRESHOLD,
  AUTO_REFILL_CREDIT_THRESHOLD,
  AUTO_REFILL_CREDIT_AMOUNT,
  AUTO_REFILL_FAUCET_COOLDOWN_MS,
  AUTO_REFILL_FUND_COOLDOWN_MS,
} from '../config/constants';

export interface UseAutoRefillOptions {
  address: string | undefined;
  isWalletConnected: boolean;
  /** Stable ref wrapping cosmos-kit's getOfflineSigner (avoids unstable closure in effect deps). */
  getOfflineSignerRef: React.RefObject<() => OfflineSigner>;
  toast: ToastContextType;
}

export function useAutoRefill({
  address,
  isWalletConnected,
  getOfflineSignerRef,
  toast,
}: UseAutoRefillOptions): void {
  const isCheckingRef = useRef(false);
  const lastFaucetAttemptRef = useRef(0);
  const lastFundAttemptRef = useRef(0);
  const addressRef = useRef(address);
  const lastEffectAddressRef = useRef<string | undefined>(undefined);
  // Stable ref for toast — avoids re-triggering the effect when toasts change the context value
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  useEffect(() => {
    addressRef.current = address;

    if (!isFaucetEnabled() || !isWalletConnected || !address) return;

    // Only reset cooldowns when the address actually changes, not on every effect re-run
    if (address !== lastEffectAddressRef.current) {
      lastFaucetAttemptRef.current = 0;
      lastFundAttemptRef.current = 0;
      lastEffectAddressRef.current = address;
    }

    // Reset mutex so a new address always gets an immediate check,
    // even if the previous address's check is still in-flight.
    // Stale-address guards inside checkAndRefill prevent the old check from acting.
    isCheckingRef.current = false;

    const targetAddress = address;
    const abortController = new AbortController();
    const { signal } = abortController;

    async function checkAndRefill() {
      if (isCheckingRef.current) return;
      isCheckingRef.current = true;

      try {
        // 1. Check wallet MFX and PWR balances
        const [mfxCoin, pwrCoin] = await Promise.all([
          getBalance(targetAddress, DENOMS.MFX),
          getBalance(targetAddress, DENOMS.PWR),
        ]);

        if (signal.aborted || addressRef.current !== targetAddress) return;

        // Validate raw amount strings before conversion. fromBaseUnits returns 0
        // for invalid input (via parseInt → NaN → 0 fallback), which would silently
        // trigger faucet/funding as if the balance were zero.
        if (!/^\d+$/.test(mfxCoin.amount) || !/^\d+$/.test(pwrCoin.amount)) {
          logError('useAutoRefill.check', new Error(
            `Unexpected balance: MFX=${mfxCoin.amount}, PWR=${pwrCoin.amount}`
          ));
          return;
        }

        const mfxBalance = fromBaseUnits(mfxCoin.amount, DENOMS.MFX);
        const pwrBalance = fromBaseUnits(pwrCoin.amount, DENOMS.PWR);

        // 2. Faucet if below thresholds and cooldown elapsed
        let faucetRan = false;
        const needsFaucet =
          mfxBalance < AUTO_REFILL_MFX_THRESHOLD ||
          pwrBalance < AUTO_REFILL_PWR_WALLET_THRESHOLD;
        const faucetCooldownElapsed =
          Date.now() - lastFaucetAttemptRef.current >= AUTO_REFILL_FAUCET_COOLDOWN_MS;

        if (needsFaucet && faucetCooldownElapsed) {
          try {
            toastRef.current.info('Sending free MFX and PWR tokens to your wallet…');
            const { results } = await requestFaucetTokens(targetAddress);
            if (signal.aborted || addressRef.current !== targetAddress) return;

            const anySuccess = results.some((r) => r.success);
            // Only stamp cooldown when at least one drip succeeded.
            // requestFaucetTokens never throws — it converts network/HTTP errors into
            // { success: false } results, so all-failed responses may be transient
            // outages that should be retried on the next interval, not locked out for 25h.
            if (anySuccess) {
              lastFaucetAttemptRef.current = Date.now();
            }
            // Only re-query PWR (step 3) when at least one drip actually deposited tokens.
            faucetRan = anySuccess;
            const allSuccess = results.every((r) => r.success);
            const allFailed = results.every((r) => !r.success);
            if (allSuccess) {
              toastRef.current.success('Free MFX and PWR tokens have been sent to your wallet.');
            } else if (allFailed) {
              toastRef.current.info('No tokens could be sent — the faucet cooldown may be active.');
            } else {
              toastRef.current.info('Some tokens could not be sent — the faucet cooldown may be active.');
            }
          } catch (error) {
            logError('useAutoRefill.faucet', error);
            toastRef.current.info('Could not reach the faucet. Will retry automatically.');
          }
        }

        if (signal.aborted || addressRef.current !== targetAddress) return;

        // 3. Check credit balance
        let currentPwr = pwrBalance;
        if (faucetRan) {
          // Re-query PWR — faucet may have deposited new tokens.
          // Fall back to original balance if re-query fails so credit funding isn't skipped.
          try {
            const freshPwr = await getBalance(targetAddress, DENOMS.PWR);
            if (signal.aborted || addressRef.current !== targetAddress) return;
            if (/^\d+$/.test(freshPwr.amount)) {
              currentPwr = fromBaseUnits(freshPwr.amount, DENOMS.PWR);
            }
          } catch (error) {
            logError('useAutoRefill.pwrRequery', error);
          }
        }

        const creditResponse = await getCreditAccount(targetAddress);
        if (signal.aborted || addressRef.current !== targetAddress) return;

        const pwrCredit = creditResponse.balances.find((c) => c.denom === DENOMS.PWR);
        if (pwrCredit && !/^\d+$/.test(pwrCredit.amount)) {
          logError('useAutoRefill.check', new Error(
            `Unexpected credit balance: ${pwrCredit.amount}`
          ));
          return;
        }
        const creditBalance = pwrCredit
          ? fromBaseUnits(pwrCredit.amount, DENOMS.PWR)
          : 0;

        // 4. Fund credits if below threshold and wallet has enough PWR
        const fundCooldownElapsed =
          Date.now() - lastFundAttemptRef.current >= AUTO_REFILL_FUND_COOLDOWN_MS;

        if (
          creditBalance < AUTO_REFILL_CREDIT_THRESHOLD &&
          currentPwr >= AUTO_REFILL_CREDIT_AMOUNT &&
          fundCooldownElapsed
        ) {
          try {
            const signer = getOfflineSignerRef.current();
            const result = await fundCredit(signer, targetAddress, targetAddress, {
              denom: DENOMS.PWR,
              amount: toBaseUnits(AUTO_REFILL_CREDIT_AMOUNT, DENOMS.PWR),
            });
            // Stamp cooldown after the TX completes (not before), so transient
            // network errors don't lock out funding for the full cooldown period.
            lastFundAttemptRef.current = Date.now();
            if (signal.aborted || addressRef.current !== targetAddress) return;
            if (result.success) {
              toastRef.current.success(`Funded ${AUTO_REFILL_CREDIT_AMOUNT} credits — you're all set!`);
            } else {
              logError('useAutoRefill.fundCredits', result.error);
              toastRef.current.info('Auto-funding credits failed. You can fund credits manually.');
            }
          } catch (error) {
            logError('useAutoRefill.fundCredits', error);
            toastRef.current.info('Auto-funding credits failed. You can fund credits manually.');
          }
        }
      } catch (error) {
        logError('useAutoRefill.check', error);
      } finally {
        // Only release if this invocation still owns the mutex.
        // On address change / unmount, the effect resets the mutex and launches a new check;
        // this stale invocation must not clear the new check's mutex.
        if (!signal.aborted && addressRef.current === targetAddress) {
          isCheckingRef.current = false;
        }
      }
    }

    // Immediate check on connect / address change
    checkAndRefill();

    // Recurring checks
    const intervalId = setInterval(checkAndRefill, AUTO_REFILL_CHECK_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      abortController.abort();
    };
  }, [isWalletConnected, address, getOfflineSignerRef]);
}
