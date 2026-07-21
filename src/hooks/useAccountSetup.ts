/**
 * useAccountSetup — one-shot sequential account setup pipeline.
 *
 * On first wallet connect (no localStorage key), runs a sequential pipeline:
 * 1. Check PWR → if low, faucetDripAndVerify → retry once → stop on failure
 * 2. Check credits → if low, fundCredits (SDK) → verify TX code → retry once → stop on failure
 *
 * Each faucet step verifies token delivery on-chain by polling getBalance()
 * until the balance increases above the pre-drip snapshot.
 *
 * No recurring interval, no cooldowns, no toast calls.
 *
 * If the localStorage key exists but wallet PWR balance is zero, the stale key
 * is cleared and setup re-runs (covers backend reset and returning users who
 * have spent their wallet PWR; the early credit check short-circuits the
 * visible re-run for users who still have credits funded).
 *
 * MFX is no longer part of this flow — PWR pays both gas and credits after
 * the gas-token cutover (ENG-243). Users who still need MFX can request it
 * via the `request_faucet` chat tool.
 */

import { useEffect, useRef, useState } from 'react';
import { noopLogger, type CosmosClientManager, type TxCtx } from '@manifest-network/manifest-sdk';
import { fundCredits } from '@manifest-network/manifest-sdk/deploy';
import { getBalance } from '../api/bank';
import { getCreditAccount } from '../api/billing';
import { DENOMS } from '../api/config';
import { faucetDripAndVerify, isFaucetEnabled } from '../api/faucet';
import { fromBaseUnits, toBaseUnits } from '../utils/format';
import { logError } from '../utils/errors';
import { createVersionedStorage } from '../utils/versionedStorage';
import {
  ACCOUNT_SETUP_PWR_THRESHOLD,
  ACCOUNT_SETUP_CREDIT_THRESHOLD,
  ACCOUNT_SETUP_CREDIT_AMOUNT,
  ACCOUNT_SETUP_GAS_RESERVE,
  ACCOUNT_SETUP_COMPLETE_DELAY_MS,
  ACCOUNT_SETUP_RETRY_DELAY_MS,
  ACCOUNT_SETUP_ERROR_DELAY_MS,
} from '../config/constants';

export interface UseAccountSetupOptions {
  address: string | undefined;
  isWalletConnected: boolean;
  /**
   * Stable ref to the signing `CosmosClientManager` (the aiStore singleton
   * `AppShell.setClientManager` also wires in — never a fresh manager, which
   * would break sync-broadcast sequencing). Read lazily at funding time so effect deps stay
   * stable. ENG-312 Phase 7: replaced the raw OfflineSigner ref now that credit
   * funding goes through the SDK's `fundCredits(TxCtx)`.
   */
  clientManagerRef: React.RefObject<CosmosClientManager | null>;
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
  clientManagerRef,
}: UseAccountSetupOptions): AccountSetupState {
  const addressRef = useRef(address);
  const lastEffectAddressRef = useRef<string | undefined>(undefined);

  const [setupState, setSetupState] = useState<AccountSetupState>(INITIAL_SETUP_STATE);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    addressRef.current = address;

    if (!isFaucetEnabled() || !isWalletConnected || !address) {
      lastEffectAddressRef.current = undefined;
      setSetupState(INITIAL_SETUP_STATE);
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
        // 1. Fetch PWR balance
        const pwrCoin = await getBalance(targetAddress, DENOMS.PWR);
        if (signal.aborted || addressRef.current !== targetAddress) return;

        if (!/^\d+$/.test(pwrCoin.amount)) {
          logError('useAccountSetup.check', new Error(
            `Unexpected balance: PWR=${pwrCoin.amount}`
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

        const pwrBalance = fromBaseUnits(pwrCoin.amount, DENOMS.PWR);

        // Stale-key detection: setupCompleted persisted but wallet PWR is zero.
        // Triggers on backend reset OR when a returning user has spent their wallet
        // PWR down. The early credit check below skips back to `complete` for users
        // who already have credits funded, so the visible re-run is rare.
        if (persisted?.setupCompleted && pwrBalance === 0) {
          clearSetupData(targetAddress);
          isNewSetup = true;
          setSetupState({ isInitialSetup: true, phase: 'checking' });
          // Fall through to run setup
        } else if (persisted?.setupCompleted) {
          // Returning wallet with balance — skip setup
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

        // 2. Faucet phase — PWR only (covers gas + credits after ENG-243)
        let setupError: string | undefined;

        if (pwrBalance < ACCOUNT_SETUP_PWR_THRESHOLD) {
          setSetupState({ isInitialSetup: true, phase: 'faucet' });

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
        // Raw (micro-unit) pre-fund credit balance — the recheck below compares
        // against this to detect a first fund that landed despite a lost/thrown
        // response, so the retry doesn't double-fund.
        const preFundCreditRaw = creditAmountValid ? BigInt(pwrCredit!.amount) : 0n;

        if (creditBalance < ACCOUNT_SETUP_CREDIT_THRESHOLD) {
          // ENG-565: post ENG-243 the gas fee shares this PWR balance and is
          // deducted by the ante BEFORE the fund-credit message runs, so require
          // enough for the credit amount PLUS a gas reserve — otherwise crediting
          // the whole faucet drip overdraws by exactly the fee. Fail cleanly here
          // instead of broadcasting a doomed tx.
          if (currentPwr < ACCOUNT_SETUP_CREDIT_AMOUNT + ACCOUNT_SETUP_GAS_RESERVE) {
            setupError = 'Not enough funds to activate credits. Please try again later.';
            setSetupState({ isInitialSetup: true, phase: 'funding', error: setupError });
            finishWithError(targetAddress, signal);
            return;
          }

          setSetupState({ isInitialSetup: true, phase: 'funding' });

          // fundCredits forwards `amount` verbatim into the billing fund-credit
          // TX, and downstream parseAmount requires a <number><denom> coin string
          // (a bare micro-digit string throws "Missing denomination"). Mirror the
          // fund_credits tool's denomString. Self-fund: the SDK defaults the
          // recipient to the connected signer's own address (no `tenant`).
          const creditCoin = `${toBaseUnits(ACCOUNT_SETUP_CREDIT_AMOUNT, DENOMS.PWR)}${DENOMS.PWR}`;

          let fundSucceeded = false;
          try {
            const clientManager = clientManagerRef.current;
            if (!clientManager) throw new Error('Signing client not ready');
            const ctx: TxCtx = { chain: clientManager, logger: noopLogger };
            const result = await fundCredits(ctx, { amount: creditCoin });
            if (signal.aborted || addressRef.current !== targetAddress) return;
            fundSucceeded = result.code === 0;
            if (!fundSucceeded) {
              logError('useAccountSetup.fundCredits', new Error(`fund-credit failed (code ${result.code})${result.rawLog ? `: ${result.rawLog}` : ''}`));
            }
          } catch (error) {
            logError('useAccountSetup.fundCredits', error);
          }

          if (!fundSucceeded) {
            // Retry once
            setSetupState({ isInitialSetup: true, phase: 'funding', error: 'Could not activate credits. Retrying...' });
            await new Promise((r) => setTimeout(r, ACCOUNT_SETUP_RETRY_DELAY_MS));
            if (signal.aborted || addressRef.current !== targetAddress) return;

            // Idempotency guard: the first fund may have committed on-chain even
            // though its response was lost or threw. Re-query the credit balance
            // before re-broadcasting — if it already rose above the pre-fund
            // snapshot, the first fund landed, so skip the second broadcast (which
            // would move ACCOUNT_SETUP_CREDIT_AMOUNT twice). Mirrors the faucet's
            // drip-and-verify.
            try {
              const recheck = await getCreditAccount(targetAddress);
              if (signal.aborted || addressRef.current !== targetAddress) return;
              const recheckCredit = recheck.balances.find((c) => c.denom === DENOMS.PWR);
              if (recheckCredit && /^\d+$/.test(recheckCredit.amount) && BigInt(recheckCredit.amount) > preFundCreditRaw) {
                fundSucceeded = true;
              }
            } catch (recheckError) {
              logError('useAccountSetup.fundCredits.recheck', recheckError);
              // recheck failed — fall through to retry (at worst behaves as today)
            }

            if (!fundSucceeded) {
              setSetupState({ isInitialSetup: true, phase: 'funding' });

              try {
                const clientManager = clientManagerRef.current;
                if (!clientManager) throw new Error('Signing client not ready');
                const ctx: TxCtx = { chain: clientManager, logger: noopLogger };
                const retryResult = await fundCredits(ctx, { amount: creditCoin });
                if (signal.aborted || addressRef.current !== targetAddress) return;
                if (retryResult.code !== 0) {
                  logError('useAccountSetup.fundCredits', new Error(`fund-credit failed (code ${retryResult.code})${retryResult.rawLog ? `: ${retryResult.rawLog}` : ''}`));
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

    void runSetup();

    return () => {
      if (dismissTimerRef.current !== null) clearTimeout(dismissTimerRef.current);
      abortController.abort();
    };
  }, [isWalletConnected, address, clientManagerRef]);

  return setupState;
}
