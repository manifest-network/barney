import { liftedinit } from '@manifest-network/manifestjs';
import { fetchJson, buildUrl } from './utils';

// Re-export Unit enum from manifestjs for type safety
export const Unit = liftedinit.sku.v1.Unit;
export type Unit = (typeof Unit)[keyof typeof Unit];

// Conversion functions from manifestjs
const { unitFromJSON: fromJSON, unitToJSON: toJSON } = liftedinit.sku.v1;

/**
 * Convert a unit enum to its string representation.
 * Used for display and API compatibility.
 */
export function unitToString(unit: Unit): string {
  return toJSON(unit);
}

/**
 * Convert a unit string to enum value.
 * Used for parsing API responses.
 */
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
  meta_hash: string;
  active: boolean;
  api_url: string;
}

export interface SKU {
  uuid: string;
  provider_uuid: string;
  name: string;
  unit: Unit;
  base_price: { denom: string; amount: string };
  meta_hash: string;
  active: boolean;
}

/**
 * Raw SKU response from API (unit is a string)
 */
interface RawSKU extends Omit<SKU, 'unit'> {
  unit: string;
}

/**
 * Convert a raw API SKU response to a typed SKU with enum unit.
 */
function parseSKU(raw: RawSKU): SKU {
  return {
    ...raw,
    unit: unitFromString(raw.unit),
  };
}

/**
 * Convert an array of raw API SKUs to typed SKUs.
 */
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
  const url = buildUrl('/liftedinit/sku/v1/providers', activeOnly ? { active_only: 'true' } : undefined);
  const data = await fetchJson<ProvidersResponse>(url, 'providers');
  return data.providers ?? [];
}

export async function getProvider(uuid: string): Promise<Provider | null> {
  const data = await fetchJson<ProviderResponse | Record<string, never>>(
    `/liftedinit/sku/v1/provider/${uuid}`,
    'provider',
    { notFoundDefault: {} }
  );
  return 'provider' in data ? data.provider : null;
}

export async function getSKUs(activeOnly = false): Promise<SKU[]> {
  const url = buildUrl('/liftedinit/sku/v1/skus', activeOnly ? { active_only: 'true' } : undefined);
  const data = await fetchJson<{ skus?: RawSKU[] }>(url, 'SKUs');
  return parseSKUs(data.skus ?? []);
}

export async function getSKU(uuid: string): Promise<SKU | null> {
  const data = await fetchJson<{ sku?: RawSKU }>(
    `/liftedinit/sku/v1/sku/${uuid}`,
    'SKU',
    { notFoundDefault: {} }
  );
  return data.sku ? parseSKU(data.sku) : null;
}

export async function getSKUsByProvider(providerUuid: string, activeOnly = false): Promise<SKU[]> {
  const url = buildUrl(
    `/liftedinit/sku/v1/skus/provider/${providerUuid}`,
    activeOnly ? { active_only: 'true' } : undefined
  );
  const data = await fetchJson<{ skus?: RawSKU[] }>(url, 'SKUs by provider');
  return parseSKUs(data.skus ?? []);
}

export async function getSKUParams(): Promise<SKUParams> {
  const data = await fetchJson<SKUParamsResponse>('/liftedinit/sku/v1/params', 'SKU params');
  return data.params;
}
