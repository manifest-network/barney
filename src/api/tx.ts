import { getSigningLiftedinitClient, liftedinit } from '@manifest-network/manifestjs';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import type { Coin } from './bank';
import { RPC_ENDPOINT } from './config';
import { getEventAttribute, type TxEvent } from '../utils/tx';
import { logError } from '../utils/errors';

// Re-export TxEvent for consumers that import from api/tx
export type { TxEvent };

// Re-export Unit from sku.ts (single source of truth)
import { Unit } from './sku';
export { Unit };

const { MsgFundCredit, MsgCreateLease, MsgCreateLeaseForTenant, MsgCancelLease, MsgCloseLease, MsgAcknowledgeLease, MsgRejectLease, MsgWithdraw } = liftedinit.billing.v1;
const { MsgCreateProvider, MsgUpdateProvider, MsgCreateSKU, MsgUpdateSKU, MsgDeactivateProvider, MsgDeactivateSKU } = liftedinit.sku.v1;

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

/**
 * Extended transaction result for lease creation.
 * Adds leaseUuid on success.
 */
export type CreateLeaseResult =
  | {
      success: true;
      transactionHash: string;
      events: readonly TxEvent[];
      leaseUuid?: string;
      error?: never;
    }
  | {
      success: false;
      error: string;
      transactionHash?: string;
      leaseUuid?: never;
      events?: never;
    };

export async function getSigningClient(signer: OfflineSigner) {
  return getSigningLiftedinitClient({
    rpcEndpoint: RPC_ENDPOINT,
    signer,
  });
}

const DEFAULT_FEE = {
  amount: [{ denom: 'umfx', amount: '0' }],
  gas: '200000',
};

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
    const result = await client.signAndBroadcast(sender, messages, DEFAULT_FEE);

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

export interface CreateProviderParams {
  address: string;
  payoutAddress: string;
  apiUrl: string;
  metaHash?: Uint8Array;
}

export async function createProvider(
  signer: OfflineSigner,
  authority: string,
  params: CreateProviderParams
): Promise<TxResult> {
  return signAndBroadcast(signer, authority, [
    buildMsg(MsgCreateProvider, {
      authority,
      address: params.address,
      payoutAddress: params.payoutAddress,
      apiUrl: params.apiUrl,
      metaHash: params.metaHash ?? new Uint8Array(),
    }),
  ]);
}

export interface UpdateProviderParams {
  uuid: string;
  address: string;
  payoutAddress: string;
  apiUrl: string;
  active: boolean;
  metaHash?: Uint8Array;
}

export async function updateProvider(
  signer: OfflineSigner,
  authority: string,
  params: UpdateProviderParams
): Promise<TxResult> {
  return signAndBroadcast(signer, authority, [
    buildMsg(MsgUpdateProvider, {
      authority,
      uuid: params.uuid,
      address: params.address,
      payoutAddress: params.payoutAddress,
      apiUrl: params.apiUrl,
      active: params.active,
      metaHash: params.metaHash ?? new Uint8Array(),
    }),
  ]);
}

export interface CreateSKUParams {
  providerUuid: string;
  name: string;
  unit: Unit;
  basePrice: Coin;
  metaHash?: Uint8Array;
}

export async function createSKU(
  signer: OfflineSigner,
  authority: string,
  params: CreateSKUParams
): Promise<TxResult> {
  return signAndBroadcast(signer, authority, [
    buildMsg(MsgCreateSKU, {
      authority,
      providerUuid: params.providerUuid,
      name: params.name,
      unit: params.unit,
      basePrice: params.basePrice,
      metaHash: params.metaHash ?? new Uint8Array(),
    }),
  ]);
}

export interface UpdateSKUParams {
  uuid: string;
  providerUuid: string;
  name: string;
  unit: Unit;
  basePrice: Coin;
  active: boolean;
  metaHash?: Uint8Array;
}

export async function updateSKU(
  signer: OfflineSigner,
  authority: string,
  params: UpdateSKUParams
): Promise<TxResult> {
  return signAndBroadcast(signer, authority, [
    buildMsg(MsgUpdateSKU, {
      authority,
      uuid: params.uuid,
      providerUuid: params.providerUuid,
      name: params.name,
      unit: params.unit,
      basePrice: params.basePrice,
      active: params.active,
      metaHash: params.metaHash ?? new Uint8Array(),
    }),
  ]);
}

export async function deactivateProvider(
  signer: OfflineSigner,
  authority: string,
  uuid: string
): Promise<TxResult> {
  return signAndBroadcast(signer, authority, [
    buildMsg(MsgDeactivateProvider, { authority, uuid }),
  ]);
}

export async function deactivateSKU(
  signer: OfflineSigner,
  authority: string,
  uuid: string
): Promise<TxResult> {
  return signAndBroadcast(signer, authority, [
    buildMsg(MsgDeactivateSKU, { authority, uuid }),
  ]);
}

// Lease transactions

export interface LeaseItemInput {
  skuUuid: string;
  quantity: number;
}

/**
 * Maps lease item inputs to the format expected by the blockchain message.
 */
function mapLeaseItems(items: LeaseItemInput[]) {
  return items.map((item) => ({
    skuUuid: item.skuUuid,
    quantity: BigInt(item.quantity),
  }));
}

/**
 * Executes a lease creation transaction and extracts the lease UUID from events.
 */
async function executeLeaseCreation(
  signer: OfflineSigner,
  sender: string,
  message: { typeUrl: string; value: unknown }
): Promise<CreateLeaseResult> {
  const result = await signAndBroadcast(signer, sender, [message]);

  if (!result.success || !result.events) {
    return result;
  }

  const leaseUuid = getEventAttribute(result.events, 'lease_created', 'lease_uuid');

  if (!leaseUuid) {
    logError('executeLeaseCreation', 'Transaction succeeded but lease_uuid not found in events');
  }

  return {
    ...result,
    leaseUuid,
  };
}

/**
 * Create a lease as the tenant.
 *
 * @param signer - Offline signer for the tenant
 * @param tenant - Address of the tenant creating the lease
 * @param items - Array of SKU items with quantities
 * @param metaHash - Optional metadata hash
 * @returns CreateLeaseResult with leaseUuid if successful
 */
export async function createLease(
  signer: OfflineSigner,
  tenant: string,
  items: LeaseItemInput[],
  metaHash?: Uint8Array
): Promise<CreateLeaseResult> {
  return executeLeaseCreation(signer, tenant,
    buildMsg(MsgCreateLease, {
      tenant,
      items: mapLeaseItems(items),
      metaHash: metaHash ?? new Uint8Array(),
    }),
  );
}

/**
 * Create a lease on behalf of a tenant. Only callable by addresses in the
 * billing module's allowed_list.
 *
 * @param signer - Offline signer for the authority
 * @param authority - Address of the admin creating the lease (must be in allowed_list)
 * @param tenant - Address of the tenant for whom the lease is created
 * @param items - Array of SKU items with quantities
 * @param metaHash - Optional metadata hash
 * @returns CreateLeaseResult with leaseUuid if successful
 */
export async function createLeaseForTenant(
  signer: OfflineSigner,
  authority: string,
  tenant: string,
  items: LeaseItemInput[],
  metaHash?: Uint8Array
): Promise<CreateLeaseResult> {
  return executeLeaseCreation(signer, authority,
    buildMsg(MsgCreateLeaseForTenant, {
      authority,
      tenant,
      items: mapLeaseItems(items),
      metaHash: metaHash ?? new Uint8Array(),
    }),
  );
}

export async function cancelLease(
  signer: OfflineSigner,
  tenant: string,
  leaseUuids: string[]
): Promise<TxResult> {
  return signAndBroadcast(signer, tenant, [
    buildMsg(MsgCancelLease, { tenant, leaseUuids }),
  ]);
}

export async function closeLease(
  signer: OfflineSigner,
  sender: string,
  leaseUuids: string[],
  reason?: string
): Promise<TxResult> {
  return signAndBroadcast(signer, sender, [
    buildMsg(MsgCloseLease, { sender, leaseUuids, reason: reason ?? '' }),
  ]);
}

// Provider transactions

export async function acknowledgeLease(
  signer: OfflineSigner,
  sender: string,
  leaseUuids: string[]
): Promise<TxResult> {
  return signAndBroadcast(signer, sender, [
    buildMsg(MsgAcknowledgeLease, { sender, leaseUuids }),
  ]);
}

export async function rejectLease(
  signer: OfflineSigner,
  sender: string,
  leaseUuids: string[],
  reason?: string
): Promise<TxResult> {
  return signAndBroadcast(signer, sender, [
    buildMsg(MsgRejectLease, { sender, leaseUuids, reason: reason ?? '' }),
  ]);
}

export async function withdrawFromLeases(
  signer: OfflineSigner,
  sender: string,
  leaseUuids: string[]
): Promise<TxResult> {
  return signAndBroadcast(signer, sender, [
    buildMsg(MsgWithdraw, { sender, leaseUuids }),
  ]);
}
