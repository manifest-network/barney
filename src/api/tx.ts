import { getSigningLiftedinitClient, liftedinit } from '@manifest-network/manifestjs';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import type { Coin } from './bank';

const RPC_ENDPOINT = 'http://localhost:26657';

const { MsgFundCredit, MsgCreateLease, MsgCancelLease, MsgCloseLease, MsgAcknowledgeLease, MsgRejectLease, MsgWithdraw } = liftedinit.billing.v1;
const { MsgCreateProvider, MsgUpdateProvider, MsgCreateSKU, MsgUpdateSKU, MsgDeactivateProvider, MsgDeactivateSKU } = liftedinit.sku.v1;

// Re-export Unit enum as a value (not type-only)
export const Unit = liftedinit.sku.v1.Unit;

export interface TxResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
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
  unit: typeof Unit[keyof typeof Unit];
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
  unit: typeof Unit[keyof typeof Unit];
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

export async function createLease(
  signer: OfflineSigner,
  tenant: string,
  items: LeaseItemInput[]
): Promise<TxResult> {
  const msg = {
    typeUrl: MsgCreateLease.typeUrl,
    value: MsgCreateLease.fromPartial({
      tenant,
      items: items.map((item) => ({
        skuUuid: item.skuUuid,
        quantity: BigInt(item.quantity),
      })),
    }),
  };

  return signAndBroadcast(signer, tenant, [msg]);
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
  leaseUuids: string[]
): Promise<TxResult> {
  const msg = {
    typeUrl: MsgCloseLease.typeUrl,
    value: MsgCloseLease.fromPartial({
      sender,
      leaseUuids,
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
