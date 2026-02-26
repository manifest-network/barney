/**
 * Faucet HTTP client.
 * Requests MFX (gas) and PWR (credits) from the CosmJS faucet.
 */

import { ACCOUNT_SETUP_POLL_INTERVAL_MS, ACCOUNT_SETUP_POLL_TIMEOUT_MS } from '../config/constants';
import { runtimeConfig } from '../config/runtimeConfig';
import { getBalance } from './bank';
import { DENOMS } from './config';
import { withRetry } from './utils';

/** Cooldown period between faucet requests per address+denom. */
export const FAUCET_COOLDOWN_HOURS = 24;

export interface FaucetDripResult {
  denom: string;
  success: boolean;
  error?: string;
}

/**
 * Returns the faucet base URL from runtime config.
 * Empty string means faucet is disabled.
 */
export function getFaucetBaseUrl(): string {
  return runtimeConfig.PUBLIC_FAUCET_URL;
}

/** Whether the faucet feature is enabled (PUBLIC_FAUCET_URL is set). */
export function isFaucetEnabled(): boolean {
  return getFaucetBaseUrl().length > 0;
}

/**
 * Request tokens from the faucet for both MFX and PWR denoms.
 * Each denom has an independent cooldown, so one may succeed while the other fails.
 */
export async function requestFaucetTokens(
  address: string
): Promise<{ results: FaucetDripResult[] }> {
  const baseUrl = getFaucetBaseUrl();
  const denoms = [DENOMS.MFX, DENOMS.PWR];

  const results = await Promise.all(
    denoms.map(async (denom): Promise<FaucetDripResult> => {
      try {
        await withRetry(
          async () => {
            const res = await fetch(`${baseUrl}/credit`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ address, denom }),
            });
            if (!res.ok) {
              const text = await res.text().catch(() => res.statusText);
              throw new Error(text || `HTTP ${res.status}`);
            }
          },
          { context: `faucet.requestTokens[${denom}]`, maxRetries: 1 }
        );
        return { denom, success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { denom, success: false, error: message };
      }
    })
  );

  return { results };
}

/**
 * Request a single-denom faucet drip.
 * Extracted from the parallel logic in requestFaucetTokens for use in the
 * sequential account setup pipeline.
 */
export async function requestFaucetDrip(
  address: string,
  denom: string,
  signal?: AbortSignal
): Promise<FaucetDripResult> {
  const baseUrl = getFaucetBaseUrl();
  try {
    await withRetry(
      async () => {
        const res = await fetch(`${baseUrl}/credit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, denom }),
          signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => res.statusText);
          throw new Error(text || `HTTP ${res.status}`);
        }
      },
      { context: `faucet.requestDrip[${denom}]`, maxRetries: 1 }
    );
    return { denom, success: true };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { denom, success: false, error: message };
  }
}

/**
 * Request a faucet drip and verify that the balance increased on chain.
 *
 * 1. Read pre-drip balance
 * 2. Fire requestFaucetDrip
 * 3. Poll getBalance at ACCOUNT_SETUP_POLL_INTERVAL_MS until balance > pre-drip, or timeout
 *
 * Uses BigInt comparison on raw amount strings to avoid float issues.
 */
export async function faucetDripAndVerify(
  address: string,
  denom: string,
  options?: { pollInterval?: number; pollTimeout?: number; signal?: AbortSignal }
): Promise<FaucetDripResult> {
  const pollInterval = options?.pollInterval ?? ACCOUNT_SETUP_POLL_INTERVAL_MS;
  const pollTimeout = options?.pollTimeout ?? ACCOUNT_SETUP_POLL_TIMEOUT_MS;
  const signal = options?.signal;

  // 1. Snapshot pre-drip balance
  const preDrip = await getBalance(address, denom);
  const preDripAmount = BigInt(preDrip.amount || '0');

  // 2. Fire faucet drip
  const drip = await requestFaucetDrip(address, denom, signal);
  if (!drip.success) return drip;

  // 3. Poll until balance increases
  const deadline = Date.now() + pollTimeout;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const current = await getBalance(address, denom);
    const currentAmount = BigInt(current.amount || '0');
    if (currentAmount > preDripAmount) {
      return { denom, success: true };
    }
  }

  return { denom, success: false, error: 'Faucet tokens not received within timeout' };
}
