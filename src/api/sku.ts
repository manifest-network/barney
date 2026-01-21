import { REST_URL } from './config';

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
  meta_hash: string;
  active: boolean;
  api_url: string;
}

export interface SKU {
  uuid: string;
  provider_uuid: string;
  name: string;
  unit: string;
  base_price: { denom: string; amount: string };
  meta_hash: string;
  active: boolean;
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
  const url = `${REST_URL}/liftedinit/sku/v1/providers${activeOnly ? '?active_only=true' : ''}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch providers: ${response.statusText}`);
  }

  const data: ProvidersResponse = await response.json();
  return data.providers || [];
}

export async function getProvider(uuid: string): Promise<Provider | null> {
  const response = await fetch(`${REST_URL}/liftedinit/sku/v1/provider/${uuid}`);

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Failed to fetch provider: ${response.statusText}`);
  }

  const data: ProviderResponse = await response.json();
  return data.provider;
}

export async function getSKUs(activeOnly = false): Promise<SKU[]> {
  const url = `${REST_URL}/liftedinit/sku/v1/skus${activeOnly ? '?active_only=true' : ''}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch SKUs: ${response.statusText}`);
  }

  const data: SKUsResponse = await response.json();
  return data.skus || [];
}

export async function getSKU(uuid: string): Promise<SKU | null> {
  const response = await fetch(`${REST_URL}/liftedinit/sku/v1/sku/${uuid}`);

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Failed to fetch SKU: ${response.statusText}`);
  }

  const data: SKUResponse = await response.json();
  return data.sku;
}

export async function getSKUsByProvider(providerUuid: string, activeOnly = false): Promise<SKU[]> {
  const url = `${REST_URL}/liftedinit/sku/v1/skus/provider/${providerUuid}${activeOnly ? '?active_only=true' : ''}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch SKUs by provider: ${response.statusText}`);
  }

  const data: SKUsResponse = await response.json();
  return data.skus || [];
}

export async function getSKUParams(): Promise<SKUParams> {
  const response = await fetch(`${REST_URL}/liftedinit/sku/v1/params`);

  if (!response.ok) {
    throw new Error(`Failed to fetch SKU params: ${response.statusText}`);
  }

  const data: SKUParamsResponse = await response.json();
  return data.params;
}
