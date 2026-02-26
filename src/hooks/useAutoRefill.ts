/**
 * useAutoRefill — recurring faucet + credit fund hook.
 *
 * Supersedes the one-shot first-login faucet that was previously inline in AppShell.
 * Unlike the old approach (which fired once for zero-balance wallets), this hook
 * monitors MFX, PWR, and credit balances on a recurring interval and automatically
 * requests faucet tokens or funds credits whenever balances drop below configured
 * thresholds. Cooldown timers prevent excessive requests.
 *
 * Cooldowns are persisted to localStorage so they survive page refreshes.
 * On the very first run for a wallet (no localStorage key), the hook exposes
 * AccountSetupState so the UI can show a blocking overlay instead of scattered toasts.
 *
 * If the cooldown key exists but wallet balances are zero (MFX and PWR), the
 * backend was likely reset — the stale key is cleared and the run is promoted
 * to initial setup so the overlay appears again.
 *
 * Gated entirely by isFaucetEnabled() — deployments without a faucet are unaffected.
 */

import { useEffect, useRef, useState } from 'react';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import { getBalance } from '../api/bank';
import { getCreditAccount } from '../api/billing';
import { DENOMS } from '../api/config';
import { requestFaucetTokens, isFaucetEnabled } from '../api/faucet';
import { fundCredit } from '../api/tx';
import { fromBaseUnits, toBaseUnits } from '../utils/format';
import { logError } from '../utils/errors';
import { createVersionedStorage } from '../utils/versionedStorage';
import type { ToastContextType } from '../contexts/ToastContext';
import {
  AUTO_REFILL_CHECK_INTERVAL_MS,
  AUTO_REFILL_MFX_THRESHOLD,
  AUTO_REFILL_PWR_WALLET_THRESHOLD,
  AUTO_REFILL_CREDIT_THRESHOLD,
  AUTO_REFILL_CREDIT_AMOUNT,
  AUTO_REFILL_FAUCET_COOLDOWN_MS,
  AUTO_REFILL_FUND_COOLDOWN_MS,
  ACCOUNT_SETUP_COMPLETE_DELAY_MS,
  ACCOUNT_SETUP_RETRY_DELAY_MS,
  ACCOUNT_SETUP_ERROR_DELAY_MS,
} from '../config/constants';

export interface UseAutoRefillOptions {
  address: string | undefined;
  isWalletConnected: boolean;
  /** Stable ref wrapping cosmos-kit's getOfflineSigner (avoids unstable closure in effect deps). */
  getOfflineSignerRef: React.RefObject<() => OfflineSigner>;
  toast: ToastContextType;
}

export type SetupPhase = 'checking' | 'faucet' | 'funding' | 'complete';

export interface AccountSetupState {
  isInitialSetup: boolean;
  phase: SetupPhase;
  error?: string;
}

// --- localStorage helpers ---

export interface CooldownsV1 {
  lastFaucetAttempt: number;
  lastFundAttempt: number;
  faucetSucceeded: boolean;
}

function migrateCooldownsV0toV1(old: unknown): CooldownsV1 | null {
  if (typeof old !== 'object' || old === null) return null;
  const o = old as Record<string, unknown>;
  if (typeof o.lastFaucetAttempt !== 'number' || typeof o.lastFundAttempt !== 'number') {
    return null;
  }
  return {
    lastFaucetAttempt: o.lastFaucetAttempt,
    lastFundAttempt: o.lastFundAttempt,
    // Old format only stamped lastFaucetAttempt on success, so a non-zero
    // timestamp implies the faucet succeeded in the older version.
    faucetSucceeded: typeof o.faucetSucceeded === 'boolean'
      ? o.faucetSucceeded
      : o.lastFaucetAttempt > 0,
  };
}

function validateCooldownsV1(data: unknown): CooldownsV1 | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (
    typeof d.lastFaucetAttempt !== 'number' ||
    typeof d.lastFundAttempt !== 'number' ||
    typeof d.faucetSucceeded !== 'boolean'
  ) {
    return null;
  }
  return d as unknown as CooldownsV1;
}

const cooldownsStorage = createVersionedStorage<CooldownsV1>({
  version: 1,
  migrations: [migrateCooldownsV0toV1],
  validate: validateCooldownsV1,
});

function cooldownKey(address: string): string {
  return `barney-refill-${address}`;
}

export function loadCooldowns(address: string): CooldownsV1 | null {
  return cooldownsStorage.load(cooldownKey(address));
}

export function saveCooldowns(address: string, cooldowns: CooldownsV1): void {
  cooldownsStorage.save(cooldownKey(address), cooldowns);
}

export function clearCooldowns(address: string): void {
  cooldownsStorage.clear(cooldownKey(address));
}

const INITIAL_SETUP_STATE: AccountSetupState = { isInitialSetup: false, phase: 'checking' };

export function useAutoRefill({
  address,
  isWalletConnected,
  getOfflineSignerRef,
  toast,
}: UseAutoRefillOptions): AccountSetupState {
  const isCheckingRef = useRef(false);
  const lastFaucetAttemptRef = useRef(0);
  const lastFundAttemptRef = useRef(0);
  const addressRef = useRef(address);
  const faucetSucceededRef = useRef(false);
  const lastEffectAddressRef = useRef<string | undefined>(undefined);
  // Stable ref for toast — avoids re-triggering the effect when toasts change the context value
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  const [setupState, setSetupState] = useState<AccountSetupState>(INITIAL_SETUP_STATE);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    addressRef.current = address;

    if (!isFaucetEnabled() || !isWalletConnected || !address) {
      setSetupState(INITIAL_SETUP_STATE);
      return;
    }

    // Only handle cooldowns when the address actually changes, not on every effect re-run
    let isInitialForAddress = false;
    if (address !== lastEffectAddressRef.current) {
      const persisted = loadCooldowns(address);
      if (persisted) {
        lastFaucetAttemptRef.current = persisted.lastFaucetAttempt;
        lastFundAttemptRef.current = persisted.lastFundAttempt;
        faucetSucceededRef.current = persisted.faucetSucceeded;
        // Returning wallet — no overlay
        setSetupState({ isInitialSetup: false, phase: 'checking' });
      } else {
        lastFaucetAttemptRef.current = 0;
        lastFundAttemptRef.current = 0;
        faucetSucceededRef.current = false;
        isInitialForAddress = true;
        // First time for this wallet — show overlay
        setSetupState({ isInitialSetup: true, phase: 'checking' });
      }
      lastEffectAddressRef.current = address;
    }

    // Reset mutex so a new address always gets an immediate check,
    // even if the previous address's check is still in-flight.
    // Stale-address guards inside checkAndRefill prevent the old check from acting.
    isCheckingRef.current = false;

    const targetAddress = address;
    // Captured once per effect lifecycle — only the first checkAndRefill invocation
    // (immediate call on connect) runs as initial setup; interval calls never do.
    let isInitialRunPending = isInitialForAddress;
    const abortController = new AbortController();
    const { signal } = abortController;

    async function checkAndRefill() {
      if (isCheckingRef.current) return;
      isCheckingRef.current = true;

      let isInitialRun = isInitialRunPending;

      try {
        if (isInitialRun) {
          setSetupState({ isInitialSetup: true, phase: 'checking' });
        }

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
          if (isInitialRun) {
            isInitialRunPending = false;
            saveCooldowns(targetAddress, { lastFaucetAttempt: 0, lastFundAttempt: 0, faucetSucceeded: faucetSucceededRef.current });
            setSetupState({ isInitialSetup: false, phase: 'complete' });
          }
          return;
        }

        const mfxBalance = fromBaseUnits(mfxCoin.amount, DENOMS.MFX);
        const pwrBalance = fromBaseUnits(pwrCoin.amount, DENOMS.PWR);

        // Stale-key detection: if the faucet previously ran (non-zero cooldown) but
        // the account is now completely empty, the backend was likely reset. Clear
        // the stale key and promote this run to initial setup so the onboarding
        // overlay appears again.
        if (!isInitialRun && mfxBalance === 0 && pwrBalance === 0 && faucetSucceededRef.current) {
          clearCooldowns(targetAddress);
          lastFaucetAttemptRef.current = 0;
          lastFundAttemptRef.current = 0;
          faucetSucceededRef.current = false;
          isInitialRunPending = true;
          isInitialRun = true;
          setSetupState({ isInitialSetup: true, phase: 'checking' });
        }

        // 2. Faucet if below thresholds and cooldown elapsed
        let faucetRan = false;
        let initialError: string | undefined;
        const needsFaucet =
          mfxBalance < AUTO_REFILL_MFX_THRESHOLD ||
          pwrBalance < AUTO_REFILL_PWR_WALLET_THRESHOLD;
        const faucetCooldownElapsed =
          Date.now() - lastFaucetAttemptRef.current >= AUTO_REFILL_FAUCET_COOLDOWN_MS;

        if (needsFaucet && faucetCooldownElapsed) {
          if (isInitialRun) {
            setSetupState({ isInitialSetup: true, phase: 'faucet' });
          }
          try {
            const { results } = await requestFaucetTokens(targetAddress);
            if (signal.aborted || addressRef.current !== targetAddress) return;

            const anySuccess = results.some((r) => r.success);
            if (anySuccess) {
              faucetSucceededRef.current = true;
              lastFaucetAttemptRef.current = Date.now();
              saveCooldowns(targetAddress, {
                lastFaucetAttempt: lastFaucetAttemptRef.current,
                lastFundAttempt: lastFundAttemptRef.current,
                faucetSucceeded: faucetSucceededRef.current,
              });
            }
            // Only re-query PWR (step 3) when at least one drip actually deposited tokens.
            faucetRan = anySuccess;
            const allSuccess = results.every((r) => r.success);
            const allFailed = results.every((r) => !r.success);

            // Retry once during initial setup if all drips failed
            if (isInitialRun && allFailed) {
              setSetupState({ isInitialSetup: true, phase: 'faucet', error: 'Could not add starter funds. Retrying...' });
              await new Promise((r) => setTimeout(r, ACCOUNT_SETUP_RETRY_DELAY_MS));
              if (signal.aborted || addressRef.current !== targetAddress) return;
              setSetupState({ isInitialSetup: true, phase: 'faucet' });
              const retry = await requestFaucetTokens(targetAddress);
              if (signal.aborted || addressRef.current !== targetAddress) return;
              const retryAny = retry.results.some((r) => r.success);
              if (retryAny) {
                faucetSucceededRef.current = true;
                lastFaucetAttemptRef.current = Date.now();
                saveCooldowns(targetAddress, {
                  lastFaucetAttempt: lastFaucetAttemptRef.current,
                  lastFundAttempt: lastFundAttemptRef.current,
                  faucetSucceeded: faucetSucceededRef.current,
                });
                faucetRan = true;
              } else {
                initialError = 'Could not add starter funds. Please try again later.';
                setSetupState({ isInitialSetup: true, phase: 'faucet', error: initialError });
              }
            } else if (!isInitialRun) {
              if (allSuccess) {
                toastRef.current.success('Starter funds have been added to your account.');
              } else if (allFailed) {
                toastRef.current.info('Funds could not be added right now. Please try again later.');
              } else {
                toastRef.current.info('Some funds could not be added right now. Please try again later.');
              }
            }
          } catch (error) {
            logError('useAutoRefill.faucet', error);
            if (isInitialRun) {
              // Retry once on exception
              setSetupState({ isInitialSetup: true, phase: 'faucet', error: 'Could not add starter funds. Retrying...' });
              await new Promise((r) => setTimeout(r, ACCOUNT_SETUP_RETRY_DELAY_MS));
              if (signal.aborted || addressRef.current !== targetAddress) return;
              setSetupState({ isInitialSetup: true, phase: 'faucet' });
              try {
                const retry = await requestFaucetTokens(targetAddress);
                if (signal.aborted || addressRef.current !== targetAddress) return;
                const retryAny = retry.results.some((r) => r.success);
                if (retryAny) {
                  faucetSucceededRef.current = true;
                  lastFaucetAttemptRef.current = Date.now();
                  saveCooldowns(targetAddress, {
                    lastFaucetAttempt: lastFaucetAttemptRef.current,
                    lastFundAttempt: lastFundAttemptRef.current,
                    faucetSucceeded: faucetSucceededRef.current,
                  });
                  faucetRan = true;
                } else {
                  initialError = 'Could not add starter funds. Please try again later.';
                  setSetupState({ isInitialSetup: true, phase: 'faucet', error: initialError });
                }
              } catch (retryError) {
                logError('useAutoRefill.faucet', retryError);
                initialError = 'Could not add starter funds. Please try again later.';
                setSetupState({ isInitialSetup: true, phase: 'faucet', error: initialError });
              }
            } else {
              toastRef.current.info('Could not add funds right now. Will retry automatically.');
            }
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
          if (isInitialRun) {
            isInitialRunPending = false;
            saveCooldowns(targetAddress, { lastFaucetAttempt: lastFaucetAttemptRef.current, lastFundAttempt: 0, faucetSucceeded: faucetSucceededRef.current });
            setSetupState({ isInitialSetup: false, phase: 'complete' });
          }
          return;
        }
        const creditBalance = pwrCredit
          ? fromBaseUnits(pwrCredit.amount, DENOMS.PWR)
          : 0;

        // 4. Fund credits if below threshold and wallet has enough PWR
        //    Skip if faucet error already set (no PWR to fund with).
        const fundCooldownElapsed =
          Date.now() - lastFundAttemptRef.current >= AUTO_REFILL_FUND_COOLDOWN_MS;

        if (
          !initialError &&
          creditBalance < AUTO_REFILL_CREDIT_THRESHOLD &&
          currentPwr >= AUTO_REFILL_CREDIT_AMOUNT &&
          fundCooldownElapsed
        ) {
          if (isInitialRun) {
            setSetupState({ isInitialSetup: true, phase: 'funding' });
          }
          let fundSucceeded = false;
          try {
            const signer = getOfflineSignerRef.current();
            const result = await fundCredit(signer, targetAddress, targetAddress, {
              denom: DENOMS.PWR,
              amount: toBaseUnits(AUTO_REFILL_CREDIT_AMOUNT, DENOMS.PWR),
            });
            if (signal.aborted || addressRef.current !== targetAddress) return;
            if (result.success) {
              fundSucceeded = true;
              lastFundAttemptRef.current = Date.now();
              saveCooldowns(targetAddress, {
                lastFaucetAttempt: lastFaucetAttemptRef.current,
                lastFundAttempt: lastFundAttemptRef.current,
                faucetSucceeded: faucetSucceededRef.current,
              });
              if (!isInitialRun) {
                toastRef.current.success('Credits activated — you\'re all set!');
              }
            } else {
              logError('useAutoRefill.fundCredits', result.error);
              if (!isInitialRun) {
                toastRef.current.info('Could not activate credits right now. Will retry automatically.');
              }
            }
          } catch (error) {
            logError('useAutoRefill.fundCredits', error);
            if (!isInitialRun) {
              toastRef.current.info('Could not activate credits right now. Will retry automatically.');
            }
          }

          // Retry once during initial setup if funding failed
          if (isInitialRun && !fundSucceeded) {
            setSetupState({ isInitialSetup: true, phase: 'funding', error: 'Could not activate credits. Retrying...' });
            await new Promise((r) => setTimeout(r, ACCOUNT_SETUP_RETRY_DELAY_MS));
            if (signal.aborted || addressRef.current !== targetAddress) return;
            setSetupState({ isInitialSetup: true, phase: 'funding' });
            try {
              const signer = getOfflineSignerRef.current();
              const retryResult = await fundCredit(signer, targetAddress, targetAddress, {
                denom: DENOMS.PWR,
                amount: toBaseUnits(AUTO_REFILL_CREDIT_AMOUNT, DENOMS.PWR),
              });
              if (signal.aborted || addressRef.current !== targetAddress) return;
              if (retryResult.success) {
                lastFundAttemptRef.current = Date.now();
                saveCooldowns(targetAddress, {
                  lastFaucetAttempt: lastFaucetAttemptRef.current,
                  lastFundAttempt: lastFundAttemptRef.current,
                  faucetSucceeded: faucetSucceededRef.current,
                });
              } else {
                logError('useAutoRefill.fundCredits', retryResult.error);
                initialError = 'Could not activate credits. Please try again later.';
                setSetupState({ isInitialSetup: true, phase: 'funding', error: initialError });
              }
            } catch (retryError) {
              logError('useAutoRefill.fundCredits', retryError);
              initialError = 'Could not activate credits. Please try again later.';
              setSetupState({ isInitialSetup: true, phase: 'funding', error: initialError });
            }
          }
        }

        // 5. Initial setup complete — persist cooldowns (even if 0) so the key exists
        if (isInitialRun && !signal.aborted && addressRef.current === targetAddress) {
          isInitialRunPending = false;
          saveCooldowns(targetAddress, {
            lastFaucetAttempt: lastFaucetAttemptRef.current,
            lastFundAttempt: lastFundAttemptRef.current,
            faucetSucceeded: faucetSucceededRef.current,
          });
          if (initialError) {
            // Error persists — show overlay with error for a delay before dismissing
            dismissTimerRef.current = setTimeout(() => {
              setSetupState({ isInitialSetup: false, phase: 'complete' });
            }, ACCOUNT_SETUP_ERROR_DELAY_MS);
          } else {
            setSetupState({ isInitialSetup: true, phase: 'complete' });
            dismissTimerRef.current = setTimeout(() => {
              setSetupState({ isInitialSetup: false, phase: 'complete' });
            }, ACCOUNT_SETUP_COMPLETE_DELAY_MS);
          }
        }
      } catch (error) {
        logError('useAutoRefill.check', error);
        if (isInitialRun && !signal.aborted && addressRef.current === targetAddress) {
          isInitialRunPending = false;
          saveCooldowns(targetAddress, { lastFaucetAttempt: lastFaucetAttemptRef.current, lastFundAttempt: lastFundAttemptRef.current, faucetSucceeded: faucetSucceededRef.current });
          setSetupState({ isInitialSetup: false, phase: 'complete' });
        }
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
      if (dismissTimerRef.current !== null) clearTimeout(dismissTimerRef.current);
      abortController.abort();
    };
  }, [isWalletConnected, address, getOfflineSignerRef]);

  return setupState;
}
