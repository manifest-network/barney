import { liftedinit } from '@manifest-network/manifestjs';
import { getQueryClient, queryWithNotFound } from './queryClient';

// Re-export Unit enum from manifestjs for type safety
export const Unit = liftedinit.sku.v1.Unit;
export type Unit = (typeof Unit)[keyof typeof Unit];

// Conversion functions from manifestjs
const { unitFromJSON: fromJSON, unitToJSON: toJSON } = liftedinit.sku.v1;

export function unitToString(unit: Unit): string {
  return toJSON(unit);
}

export function unitFromString(unit: string): Unit {
  return fromJSON(unit);
}

export interface SKUParams {
  allowed_list: string[];
}

export interface SKUParamsResponse {
  params: SKUParams;
}

export interface Provider {
  uuid: string;
  address: string;
  payout_address: string;
  meta_hash?: string | null;
  active: boolean;
  api_url: string;
}

export interface SKU {
  uuid: string;
  provider_uuid: string;
  name: string;
  unit: Unit;
  base_price: { denom: string; amount: string };
  meta_hash?: string | null;
  active: boolean;
}

interface RawSKU {
  uuid: string;
  provider_uuid: string;
  name: string;
  unit: string;
  base_price: { denom: string; amount: string };
  meta_hash?: string | null;
  active: boolean;
}

function parseSKU(raw: RawSKU): SKU {
  return {
    ...raw,
    unit: unitFromString(raw.unit),
  };
}

function parseSKUs(raw: RawSKU[]): SKU[] {
  return raw.map(parseSKU);
}

export interface ProvidersResponse {
  providers: Provider[];
}

export interface ProviderResponse {
  provider: Provider;
}

export interface SKUsResponse {
  skus: SKU[];
}

export interface SKUResponse {
  sku: SKU;
}

export async function getProviders(activeOnly = false): Promise<Provider[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.sku.v1.providers({ activeOnly });
  return (data.providers ?? []) as unknown as Provider[];
}

export async function getProvider(uuid: string): Promise<Provider | null> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.sku.v1.provider({ uuid }),
    null,
  );
  if (!data) return null;
  return data.provider as unknown as Provider;
}

export async function getSKUs(activeOnly = false): Promise<SKU[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.sku.v1.sKUs({ activeOnly });
  return parseSKUs((data.skus ?? []) as unknown as RawSKU[]);
}

export async function getSKU(uuid: string): Promise<SKU | null> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.sku.v1.sKU({ uuid }),
    null,
  );
  if (!data) return null;
  return parseSKU(data.sku as unknown as RawSKU);
}

export async function getSKUsByProvider(providerUuid: string, activeOnly = false): Promise<SKU[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.sku.v1.sKUsByProvider({ providerUuid, activeOnly });
  return parseSKUs((data.skus ?? []) as unknown as RawSKU[]);
}

export async function getSKUParams(): Promise<SKUParams> {
  const client = await getQueryClient();
  const data = await client.liftedinit.sku.v1.params();
  return data.params as unknown as SKUParams;
}
