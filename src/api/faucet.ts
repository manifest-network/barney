/**
 * Faucet HTTP client.
 * Requests MFX (gas) and PWR (credits) from the CosmJS faucet.
 */

import { runtimeConfig } from '../config/runtimeConfig';
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
        const result = await withRetry(
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
        // withRetry returns void here (fetch doesn't return a value we use)
        void result;
        return { denom, success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { denom, success: false, error: message };
      }
    })
  );

  return { results };
}
