/**
 * Faucet client — thin wrapper around @manifest-network/manifest-mcp-chain
 * faucet functions, plus Barney-specific drip-and-verify logic for account setup.
 */

import { requestFaucetCredit } from '@manifest-network/manifest-mcp-chain';

import { ACCOUNT_SETUP_POLL_INTERVAL_MS, ACCOUNT_SETUP_POLL_TIMEOUT_MS } from '../config/constants';
import { runtimeConfig } from '../config/runtimeConfig';
import { getBalance } from './bank';

/** Cooldown period between faucet requests per address+denom. */
export const FAUCET_COOLDOWN_HOURS = 24;

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
 * Request a faucet drip and verify that the balance increased on chain.
 *
 * 1. Read pre-drip balance
 * 2. Fire requestFaucetCredit (from @manifest-network/manifest-mcp-chain)
 * 3. Poll getBalance at ACCOUNT_SETUP_POLL_INTERVAL_MS until balance > pre-drip, or timeout
 *
 * Uses BigInt comparison on raw amount strings to avoid float issues.
 */
export async function faucetDripAndVerify(
  address: string,
  denom: string,
  options?: { pollInterval?: number; pollTimeout?: number; signal?: AbortSignal }
): Promise<{ denom: string; success: boolean; error?: string }> {
  const pollInterval = options?.pollInterval ?? ACCOUNT_SETUP_POLL_INTERVAL_MS;
  const pollTimeout = options?.pollTimeout ?? ACCOUNT_SETUP_POLL_TIMEOUT_MS;
  const signal = options?.signal;

  // 1. Snapshot pre-drip balance
  let preDripAmount: bigint;
  try {
    const preDrip = await getBalance(address, denom);
    if (!/^\d+$/.test(preDrip.amount || '')) {
      return { denom, success: false, error: `Invalid pre-drip balance: ${preDrip.amount}` };
    }
    preDripAmount = BigInt(preDrip.amount);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { denom, success: false, error: `Failed to read balance: ${message}` };
  }

  // 2. Fire faucet drip (requestFaucetCredit never throws — returns { success: false } on error)
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const drip = await requestFaucetCredit(getFaucetBaseUrl(), address, denom);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!drip.success) return { denom, success: false, error: drip.error };

  // 3. Poll until balance increases
  const deadline = Date.now() + pollTimeout;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    try {
      const current = await getBalance(address, denom);
      if (/^\d+$/.test(current.amount || '') && BigInt(current.amount) > preDripAmount) {
        return { denom, success: true };
      }
    } catch {
      // Transient polling failure — continue to next iteration
    }
  }

  return { denom, success: false, error: 'Faucet tokens not received within timeout' };
}
