import { getSigningLiftedinitClientOptions, liftedinit } from '@manifest-network/manifestjs';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient } from '@cosmjs/stargate';
import type { Coin } from './bank';
import { RPC_ENDPOINT } from './config';
import { GAS_PRICE } from '../config/chain';
import type { TxEvent } from '../utils/tx';
import { logError } from '../utils/errors';

// Re-export TxEvent for consumers that import from api/tx
export type { TxEvent };

// Re-export Unit from sku.ts (single source of truth)
import { Unit } from './sku';
export { Unit };

const { MsgFundCredit } = liftedinit.billing.v1;

/**
 * Discriminated union for transaction results.
 * - Success: { success: true, transactionHash: '...', events: [...] }
 * - Failure: { success: false, error: '...', transactionHash?: '...' }
 */
export type TxResult =
  | {
      success: true;
      transactionHash: string;
      events: readonly TxEvent[];
      error?: never;
    }
  | {
      success: false;
      error: string;
      transactionHash?: string;
      events?: never;
    };

export interface LeaseItemInput {
  skuUuid: string;
  quantity: number;
}

export async function getSigningClient(signer: OfflineSigner) {
  const { registry, aminoTypes } = getSigningLiftedinitClientOptions();
  return SigningStargateClient.connectWithSigner(RPC_ENDPOINT, signer, {
    registry,
    aminoTypes,
    gasPrice: GasPrice.fromString(GAS_PRICE),
  });
}

/**
 * Build a signed message from a manifestjs Msg encoder and partial fields.
 * Uses `any` for the fromPartial parameter because manifestjs generates
 * overly restrictive intersection types (Record<string|number|symbol, never>)
 * that prevent passing object literals. Same workaround as lcdConvert().
 */
function buildMsg(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Msg: { typeUrl: string; fromPartial: (value: any) => unknown },
  value: Record<string, unknown>
): { typeUrl: string; value: unknown } {
  return { typeUrl: Msg.typeUrl, value: Msg.fromPartial(value) };
}

async function signAndBroadcast(
  signer: OfflineSigner,
  sender: string,
  messages: { typeUrl: string; value: unknown }[]
): Promise<TxResult> {
  try {
    const client = await getSigningClient(signer);
    const result = await client.signAndBroadcast(sender, messages, 'auto');

    if (result.code !== 0) {
      return {
        success: false,
        transactionHash: result.transactionHash,
        error: `Transaction failed with code ${result.code}: ${result.rawLog}`,
      };
    }

    return {
      success: true,
      transactionHash: result.transactionHash,
      events: result.events,
    };
  } catch (err) {
    logError('tx.signAndBroadcast', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export async function fundCredit(
  signer: OfflineSigner,
  sender: string,
  tenant: string,
  amount: Coin
): Promise<TxResult> {
  return signAndBroadcast(signer, sender, [
    buildMsg(MsgFundCredit, { sender, tenant, amount }),
  ]);
}
