import { getSigningLiftedinitClient, liftedinit } from '@manifest-network/manifestjs';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import type { Coin } from './bank';
import { RPC_ENDPOINT } from './config';

// Re-export Unit from sku.ts (single source of truth)
import { Unit } from './sku';
export { Unit };

const { MsgFundCredit, MsgCreateLease, MsgCreateLeaseForTenant, MsgCancelLease, MsgCloseLease, MsgAcknowledgeLease, MsgRejectLease, MsgWithdraw } = liftedinit.billing.v1;
const { MsgCreateProvider, MsgUpdateProvider, MsgCreateSKU, MsgUpdateSKU, MsgDeactivateProvider, MsgDeactivateSKU } = liftedinit.sku.v1;

export interface TxResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
  events?: readonly { type: string; attributes: readonly { key: string; value: string }[] }[];
}

export interface CreateLeaseResult extends TxResult {
  leaseUuid?: string;
}

/**
 * Extract an attribute value from transaction events.
 */
function getEventAttribute(
  events: readonly { type: string; attributes: readonly { key: string; value: string }[] }[],
  eventType: string,
  attributeKey: string
): string | undefined {
  for (const event of events) {
    if (event.type === eventType) {
      for (const attr of event.attributes) {
        if (attr.key === attributeKey) {
          return attr.value;
        }
      }
    }
  }
  return undefined;
}

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
  const msg = {
    typeUrl: MsgFundCredit.typeUrl,
    value: MsgFundCredit.fromPartial({
      sender,
      tenant,
      amount,
    }),
  };

  return signAndBroadcast(signer, sender, [msg]);
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
  const msg = {
    typeUrl: MsgCreateProvider.typeUrl,
    value: MsgCreateProvider.fromPartial({
      authority,
      address: params.address,
      payoutAddress: params.payoutAddress,
      apiUrl: params.apiUrl,
      metaHash: params.metaHash ?? new Uint8Array(),
    }),
  };

  return signAndBroadcast(signer, authority, [msg]);
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
  const msg = {
    typeUrl: MsgUpdateProvider.typeUrl,
    value: MsgUpdateProvider.fromPartial({
      authority,
      uuid: params.uuid,
      address: params.address,
      payoutAddress: params.payoutAddress,
      apiUrl: params.apiUrl,
      active: params.active,
      metaHash: params.metaHash ?? new Uint8Array(),
    }),
  };

  return signAndBroadcast(signer, authority, [msg]);
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
  const msg = {
    typeUrl: MsgCreateSKU.typeUrl,
    value: MsgCreateSKU.fromPartial({
      authority,
      providerUuid: params.providerUuid,
      name: params.name,
      unit: params.unit,
      basePrice: params.basePrice,
      metaHash: params.metaHash ?? new Uint8Array(),
    }),
  };

  return signAndBroadcast(signer, authority, [msg]);
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
  const msg = {
    typeUrl: MsgUpdateSKU.typeUrl,
    value: MsgUpdateSKU.fromPartial({
      authority,
      uuid: params.uuid,
      providerUuid: params.providerUuid,
      name: params.name,
      unit: params.unit,
      basePrice: params.basePrice,
      active: params.active,
      metaHash: params.metaHash ?? new Uint8Array(),
    }),
  };

  return signAndBroadcast(signer, authority, [msg]);
}

export async function deactivateProvider(
  signer: OfflineSigner,
  authority: string,
  uuid: string
): Promise<TxResult> {
  const msg = {
    typeUrl: MsgDeactivateProvider.typeUrl,
    value: MsgDeactivateProvider.fromPartial({
      authority,
      uuid,
    }),
  };

  return signAndBroadcast(signer, authority, [msg]);
}

export async function deactivateSKU(
  signer: OfflineSigner,
  authority: string,
  uuid: string
): Promise<TxResult> {
  const msg = {
    typeUrl: MsgDeactivateSKU.typeUrl,
    value: MsgDeactivateSKU.fromPartial({
      authority,
      uuid,
    }),
  };

  return signAndBroadcast(signer, authority, [msg]);
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

  if (!leaseUuid && import.meta.env.DEV) {
    console.warn('[executeLeaseCreation] Transaction succeeded but lease_uuid not found in events');
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
  const msg = {
    typeUrl: MsgCreateLease.typeUrl,
    value: MsgCreateLease.fromPartial({
      tenant,
      items: mapLeaseItems(items),
      metaHash: metaHash ?? new Uint8Array(),
    }),
  };

  return executeLeaseCreation(signer, tenant, msg);
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
  const msg = {
    typeUrl: MsgCreateLeaseForTenant.typeUrl,
    value: MsgCreateLeaseForTenant.fromPartial({
      authority,
      tenant,
      items: mapLeaseItems(items),
      metaHash: metaHash ?? new Uint8Array(),
    }),
  };

  return executeLeaseCreation(signer, authority, msg);
}

export async function cancelLease(
  signer: OfflineSigner,
  tenant: string,
  leaseUuids: string[]
): Promise<TxResult> {
  const msg = {
    typeUrl: MsgCancelLease.typeUrl,
    value: MsgCancelLease.fromPartial({
      tenant,
      leaseUuids,
    }),
  };

  return signAndBroadcast(signer, tenant, [msg]);
}

export async function closeLease(
  signer: OfflineSigner,
  sender: string,
  leaseUuids: string[],
  reason?: string
): Promise<TxResult> {
  const msg = {
    typeUrl: MsgCloseLease.typeUrl,
    value: MsgCloseLease.fromPartial({
      sender,
      leaseUuids,
      reason: reason ?? '',
    }),
  };

  return signAndBroadcast(signer, sender, [msg]);
}

// Provider transactions

export async function acknowledgeLease(
  signer: OfflineSigner,
  sender: string,
  leaseUuids: string[]
): Promise<TxResult> {
  const msg = {
    typeUrl: MsgAcknowledgeLease.typeUrl,
    value: MsgAcknowledgeLease.fromPartial({
      sender,
      leaseUuids,
    }),
  };

  return signAndBroadcast(signer, sender, [msg]);
}

export async function rejectLease(
  signer: OfflineSigner,
  sender: string,
  leaseUuids: string[],
  reason?: string
): Promise<TxResult> {
  const msg = {
    typeUrl: MsgRejectLease.typeUrl,
    value: MsgRejectLease.fromPartial({
      sender,
      leaseUuids,
      reason: reason ?? '',
    }),
  };

  return signAndBroadcast(signer, sender, [msg]);
}

export async function withdrawFromLeases(
  signer: OfflineSigner,
  sender: string,
  leaseUuids: string[]
): Promise<TxResult> {
  const msg = {
    typeUrl: MsgWithdraw.typeUrl,
    value: MsgWithdraw.fromPartial({
      sender,
      leaseUuids,
    }),
  };

  return signAndBroadcast(signer, sender, [msg]);
}
