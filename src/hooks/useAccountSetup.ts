/**
 * useAccountSetup — one-shot sequential account setup pipeline.
 *
 * On first wallet connect (no localStorage key), runs a sequential pipeline:
 * 1. Check MFX → if low, faucetDripAndVerify → retry once → stop on failure
 * 2. Check PWR → if low, faucetDripAndVerify → retry once → stop on failure
 * 3. Check credits → if low, fundCredit → verify TX result → retry once → stop on failure
 *
 * Each faucet step verifies token delivery on-chain by polling getBalance()
 * until the balance increases above the pre-drip snapshot.
 *
 * No recurring interval, no cooldowns, no toast calls.
 *
 * If the localStorage key exists but both balances are zero (backend reset),
 * the stale key is cleared and setup re-runs.
 */

import { useEffect, useRef, useState } from 'react';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import { getBalance } from '../api/bank';
import { getCreditAccount } from '../api/billing';
import { DENOMS } from '../api/config';
import { faucetDripAndVerify, isFaucetEnabled } from '../api/faucet';
import { fundCredit } from '../api/tx';
import { fromBaseUnits, toBaseUnits } from '../utils/format';
import { logError } from '../utils/errors';
import { createVersionedStorage } from '../utils/versionedStorage';
import {
  ACCOUNT_SETUP_MFX_THRESHOLD,
  ACCOUNT_SETUP_PWR_THRESHOLD,
  ACCOUNT_SETUP_CREDIT_THRESHOLD,
  ACCOUNT_SETUP_CREDIT_AMOUNT,
  ACCOUNT_SETUP_COMPLETE_DELAY_MS,
  ACCOUNT_SETUP_RETRY_DELAY_MS,
  ACCOUNT_SETUP_ERROR_DELAY_MS,
} from '../config/constants';

export interface UseAccountSetupOptions {
  address: string | undefined;
  isWalletConnected: boolean;
  /** Stable ref wrapping cosmos-kit's getOfflineSigner (avoids unstable closure in effect deps). */
  getOfflineSignerRef: React.RefObject<() => OfflineSigner>;
}

export type SetupPhase = 'checking' | 'faucet' | 'funding' | 'complete';

export interface AccountSetupState {
  isInitialSetup: boolean;
  phase: SetupPhase;
  error?: string;
}

// --- localStorage helpers ---

/** V1 shape from the old useAutoRefill hook (for migration). */
interface CooldownsV1 {
  lastFaucetAttempt: number;
  lastFundAttempt: number;
  faucetSucceeded: boolean;
}

export interface SetupDataV2 {
  setupCompleted: boolean;
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
    faucetSucceeded: typeof o.faucetSucceeded === 'boolean'
      ? o.faucetSucceeded
      : o.lastFaucetAttempt > 0,
  };
}

function migrateV1toV2(old: unknown): SetupDataV2 | null {
  if (typeof old !== 'object' || old === null) return null;
  const o = old as Record<string, unknown>;
  // V1 had faucetSucceeded + lastFundAttempt — either signals setup completed
  const hasFund = typeof o.lastFundAttempt === 'number' && o.lastFundAttempt > 0;
  if (typeof o.faucetSucceeded === 'boolean') {
    return { setupCompleted: o.faucetSucceeded || hasFund };
  }
  // V1 had lastFaucetAttempt / lastFundAttempt — either having run means setup completed
  const hasFaucet = typeof o.lastFaucetAttempt === 'number' && o.lastFaucetAttempt > 0;
  if (hasFaucet || hasFund) {
    return { setupCompleted: true };
  }
  return null;
}

function validateSetupDataV2(data: unknown): SetupDataV2 | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.setupCompleted !== 'boolean') return null;
  return d as unknown as SetupDataV2;
}

const setupStorage = createVersionedStorage<SetupDataV2>({
  version: 2,
  migrations: [migrateCooldownsV0toV1, migrateV1toV2],
  validate: validateSetupDataV2,
});

function storageKey(address: string): string {
  return `barney-refill-${address}`;
}

export function loadSetupData(address: string): SetupDataV2 | null {
  return setupStorage.load(storageKey(address));
}

export function saveSetupData(address: string, data: SetupDataV2): void {
  setupStorage.save(storageKey(address), data);
}

export function clearSetupData(address: string): void {
  setupStorage.clear(storageKey(address));
}

const INITIAL_SETUP_STATE: AccountSetupState = { isInitialSetup: false, phase: 'checking' };

export function useAccountSetup({
  address,
  isWalletConnected,
  getOfflineSignerRef,
}: UseAccountSetupOptions): AccountSetupState {
  const addressRef = useRef(address);
  const lastEffectAddressRef = useRef<string | undefined>(undefined);

  const [setupState, setSetupState] = useState<AccountSetupState>(INITIAL_SETUP_STATE);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    addressRef.current = address;

    if (!isFaucetEnabled() || !isWalletConnected || !address) {
      lastEffectAddressRef.current = undefined;
      setSetupState(INITIAL_SETUP_STATE); // eslint-disable-line react-hooks/set-state-in-effect -- guard reset on disconnect
      return;
    }

    // Only run setup when the address actually changes
    if (address === lastEffectAddressRef.current) return;
    lastEffectAddressRef.current = address;

    // Check if setup already completed for this address.
    // Start with overlay hidden — runSetup will show it only if work is actually needed.
    const persisted = loadSetupData(address);
    setSetupState({ isInitialSetup: false, phase: 'checking' });

    const targetAddress = address;
    const abortController = new AbortController();
    const { signal } = abortController;

    async function runSetup() {
      let isNewSetup = !persisted?.setupCompleted;
      try {
        // 1. Fetch balances
        const [mfxCoin, pwrCoin] = await Promise.all([
          getBalance(targetAddress, DENOMS.MFX),
          getBalance(targetAddress, DENOMS.PWR),
        ]);
        if (signal.aborted || addressRef.current !== targetAddress) return;

        if (!/^\d+$/.test(mfxCoin.amount) || !/^\d+$/.test(pwrCoin.amount)) {
          logError('useAccountSetup.check', new Error(
            `Unexpected balance: MFX=${mfxCoin.amount}, PWR=${pwrCoin.amount}`
          ));
          if (isNewSetup) {
            setSetupState({ isInitialSetup: true, phase: 'checking', error: 'Could not check balances. Please try again later.' });
            finishWithError(targetAddress, signal);
          } else {
            // Returning wallet: preserve setupCompleted on transient RPC/parse errors
            setSetupState({ isInitialSetup: false, phase: 'complete' });
          }
          return;
        }

        const mfxBalance = fromBaseUnits(mfxCoin.amount, DENOMS.MFX);
        const pwrBalance = fromBaseUnits(pwrCoin.amount, DENOMS.PWR);

        // Stale-key detection: if we had setupCompleted but balances are zero,
        // backend was reset — clear and re-run
        if (persisted?.setupCompleted && mfxBalance === 0 && pwrBalance === 0) {
          clearSetupData(targetAddress);
          isNewSetup = true;
          setSetupState({ isInitialSetup: true, phase: 'checking' });
          // Fall through to run setup
        } else if (persisted?.setupCompleted) {
          // Returning wallet with balances — skip setup
          setSetupState({ isInitialSetup: false, phase: 'complete' });
          return;
        }

        // Already-initialized detection: skip setup if credits are funded.
        // Handles connecting an existing account on a new device without localStorage.
        if (isNewSetup) {
          try {
            const earlyCredit = await getCreditAccount(targetAddress);
            if (signal.aborted || addressRef.current !== targetAddress) return;
            const earlyPwrCredit = earlyCredit.balances.find((c) => c.denom === DENOMS.PWR);
            const earlyValid = earlyPwrCredit ? /^\d+$/.test(earlyPwrCredit.amount) : false;
            const earlyCreditBal = earlyValid ? fromBaseUnits(earlyPwrCredit!.amount, DENOMS.PWR) : 0;
            if (earlyCreditBal > 0) {
              saveSetupData(targetAddress, { setupCompleted: true });
              setSetupState({ isInitialSetup: false, phase: 'complete' });
              return;
            }
          } catch (err) {
            logError('Early credit check failed in useAccountSetup', err);
          }
          if (signal.aborted || addressRef.current !== targetAddress) return;
          // Genuinely needs setup — now show the overlay
          setSetupState({ isInitialSetup: true, phase: 'checking' });
        }

        // 2. Faucet phase
        let setupError: string | undefined;

        if (mfxBalance < ACCOUNT_SETUP_MFX_THRESHOLD || pwrBalance < ACCOUNT_SETUP_PWR_THRESHOLD) {
          setSetupState({ isInitialSetup: true, phase: 'faucet' });

          // MFX drip
          if (mfxBalance < ACCOUNT_SETUP_MFX_THRESHOLD) {
            const mfxResult = await faucetDripAndVerify(targetAddress, DENOMS.MFX, { signal });
            if (signal.aborted || addressRef.current !== targetAddress) return;

            if (!mfxResult.success) {
              // Retry once
              setSetupState({ isInitialSetup: true, phase: 'faucet', error: 'Could not add starter funds. Retrying...' });
              await new Promise((r) => setTimeout(r, ACCOUNT_SETUP_RETRY_DELAY_MS));
              if (signal.aborted || addressRef.current !== targetAddress) return;
              setSetupState({ isInitialSetup: true, phase: 'faucet' });

              const retry = await faucetDripAndVerify(targetAddress, DENOMS.MFX, { signal });
              if (signal.aborted || addressRef.current !== targetAddress) return;

              if (!retry.success) {
                setupError = 'Could not add starter funds. Please try again later.';
                setSetupState({ isInitialSetup: true, phase: 'faucet', error: setupError });
                finishWithError(targetAddress, signal);
                return;
              }
            }
          }

          // PWR drip
          if (!setupError && pwrBalance < ACCOUNT_SETUP_PWR_THRESHOLD) {
            if (signal.aborted || addressRef.current !== targetAddress) return;

            const pwrResult = await faucetDripAndVerify(targetAddress, DENOMS.PWR, { signal });
            if (signal.aborted || addressRef.current !== targetAddress) return;

            if (!pwrResult.success) {
              // Retry once
              setSetupState({ isInitialSetup: true, phase: 'faucet', error: 'Could not add starter funds. Retrying...' });
              await new Promise((r) => setTimeout(r, ACCOUNT_SETUP_RETRY_DELAY_MS));
              if (signal.aborted || addressRef.current !== targetAddress) return;
              setSetupState({ isInitialSetup: true, phase: 'faucet' });

              const retry = await faucetDripAndVerify(targetAddress, DENOMS.PWR, { signal });
              if (signal.aborted || addressRef.current !== targetAddress) return;

              if (!retry.success) {
                setupError = 'Could not add starter funds. Please try again later.';
                setSetupState({ isInitialSetup: true, phase: 'faucet', error: setupError });
                finishWithError(targetAddress, signal);
                return;
              }
            }
          }
        }

        if (signal.aborted || addressRef.current !== targetAddress) return;

        // 3. Funding phase — re-query PWR + credits
        const [freshPwr, creditResponse] = await Promise.all([
          getBalance(targetAddress, DENOMS.PWR),
          getCreditAccount(targetAddress),
        ]);
        if (signal.aborted || addressRef.current !== targetAddress) return;

        const freshPwrValid = /^\d+$/.test(freshPwr.amount);
        if (!freshPwrValid) {
          logError('useAccountSetup.freshPwr', new Error(`Invalid fresh PWR balance: ${freshPwr.amount}`));
        }
        const currentPwr = freshPwrValid ? fromBaseUnits(freshPwr.amount, DENOMS.PWR) : pwrBalance;

        const pwrCredit = creditResponse.balances.find((c) => c.denom === DENOMS.PWR);
        const creditAmountValid = pwrCredit ? /^\d+$/.test(pwrCredit.amount) : false;
        if (pwrCredit && !creditAmountValid) {
          logError('useAccountSetup.creditBalance', new Error(`Invalid credit balance: ${pwrCredit.amount}`));
        }
        const creditBalance = creditAmountValid ? fromBaseUnits(pwrCredit!.amount, DENOMS.PWR) : 0;

        if (creditBalance < ACCOUNT_SETUP_CREDIT_THRESHOLD) {
          if (currentPwr < ACCOUNT_SETUP_CREDIT_AMOUNT) {
            setupError = 'Not enough funds to activate credits. Please try again later.';
            setSetupState({ isInitialSetup: true, phase: 'funding', error: setupError });
            finishWithError(targetAddress, signal);
            return;
          }

          setSetupState({ isInitialSetup: true, phase: 'funding' });

          let fundSucceeded = false;
          try {
            const signer = getOfflineSignerRef.current();
            const result = await fundCredit(signer, targetAddress, targetAddress, {
              denom: DENOMS.PWR,
              amount: toBaseUnits(ACCOUNT_SETUP_CREDIT_AMOUNT, DENOMS.PWR),
            });
            if (signal.aborted || addressRef.current !== targetAddress) return;
            fundSucceeded = result.success;
            if (!fundSucceeded) {
              logError('useAccountSetup.fundCredits', result.error);
            }
          } catch (error) {
            logError('useAccountSetup.fundCredits', error);
          }

          if (!fundSucceeded) {
            // Retry once
            setSetupState({ isInitialSetup: true, phase: 'funding', error: 'Could not activate credits. Retrying...' });
            await new Promise((r) => setTimeout(r, ACCOUNT_SETUP_RETRY_DELAY_MS));
            if (signal.aborted || addressRef.current !== targetAddress) return;
            setSetupState({ isInitialSetup: true, phase: 'funding' });

            try {
              const signer = getOfflineSignerRef.current();
              const retryResult = await fundCredit(signer, targetAddress, targetAddress, {
                denom: DENOMS.PWR,
                amount: toBaseUnits(ACCOUNT_SETUP_CREDIT_AMOUNT, DENOMS.PWR),
              });
              if (signal.aborted || addressRef.current !== targetAddress) return;
              if (!retryResult.success) {
                logError('useAccountSetup.fundCredits', retryResult.error);
                setupError = 'Could not activate credits. Please try again later.';
                setSetupState({ isInitialSetup: true, phase: 'funding', error: setupError });
                finishWithError(targetAddress, signal);
                return;
              }
            } catch (retryError) {
              logError('useAccountSetup.fundCredits', retryError);
              setupError = 'Could not activate credits. Please try again later.';
              setSetupState({ isInitialSetup: true, phase: 'funding', error: setupError });
              finishWithError(targetAddress, signal);
              return;
            }
          }
        }

        // 4. Complete
        if (signal.aborted || addressRef.current !== targetAddress) return;
        saveSetupData(targetAddress, { setupCompleted: true });
        setSetupState({ isInitialSetup: true, phase: 'complete' });
        dismissTimerRef.current = setTimeout(() => {
          setSetupState({ isInitialSetup: false, phase: 'complete' });
        }, ACCOUNT_SETUP_COMPLETE_DELAY_MS);
      } catch (error) {
        if (signal.aborted || addressRef.current !== targetAddress) return;
        logError('useAccountSetup.run', error);
        if (isNewSetup) {
          setSetupState({ isInitialSetup: true, phase: 'checking', error: 'Something went wrong. Please try again later.' });
          finishWithError(targetAddress, signal);
        } else {
          // Returning wallet: preserve setupCompleted on transient errors
          setSetupState({ isInitialSetup: false, phase: 'complete' });
        }
      }
    }

    function finishWithError(addr: string, sig: AbortSignal) {
      if (sig.aborted || addressRef.current !== addr) return;
      saveSetupData(addr, { setupCompleted: false });
      dismissTimerRef.current = setTimeout(() => {
        setSetupState({ isInitialSetup: false, phase: 'complete' });
      }, ACCOUNT_SETUP_ERROR_DELAY_MS);
    }

    runSetup();

    return () => {
      if (dismissTimerRef.current !== null) clearTimeout(dismissTimerRef.current);
      abortController.abort();
    };
  }, [isWalletConnected, address, getOfflineSignerRef]);

  return setupState;
}
