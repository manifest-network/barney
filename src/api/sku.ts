/* eslint-disable @typescript-eslint/no-explicit-any -- LCD returns untyped JSON; `as any` is needed for fromAmino() */
import { liftedinit } from '@manifest-network/manifestjs';
import type {
  Params as SKUParams,
  Provider,
  SKU,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/sku/v1/types';
import { getQueryClient, queryWithNotFound } from './queryClient';

// Re-export manifestjs types for consumers
export type { SKUParams, Provider, SKU };

// Re-export Unit enum from manifestjs for type safety
export const Unit = liftedinit.sku.v1.Unit;
export type Unit = (typeof Unit)[keyof typeof Unit];

// Conversion functions from manifestjs
const { unitFromJSON: fromJSON, unitToJSON: toJSON } = liftedinit.sku.v1;

// fromAmino converters for query responses
const {
  QueryParamsResponse: QueryParamsResponseConverter,
  QueryProviderResponse: QueryProviderResponseConverter,
  QueryProvidersResponse: QueryProvidersResponseConverter,
  QuerySKUResponse: QuerySKUResponseConverter,
  QuerySKUsResponse: QuerySKUsResponseConverter,
} = liftedinit.sku.v1;

export function unitToString(unit: Unit): string {
  return toJSON(unit);
}

export function unitFromString(unit: string): Unit {
  return fromJSON(unit);
}

// fromAmino doesn't convert enum strings to numeric values; LCD returns strings like "UNIT_PER_HOUR"
// but Unit enum keys are numeric (0, 1, 2, ...). This fixes the mismatch.
function fixSKUEnums(sku: SKU): SKU {
  return { ...sku, unit: fromJSON(sku.unit) };
}

export async function getProviders(activeOnly = false): Promise<Provider[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.sku.v1.providers({ activeOnly });
  const converted = QueryProvidersResponseConverter.fromAmino(data as any);
  return converted.providers;
}

export async function getProvider(uuid: string): Promise<Provider | null> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.sku.v1.provider({ uuid }),
    null,
  );
  if (!data) return null;
  const converted = QueryProviderResponseConverter.fromAmino(data as any);
  return converted.provider;
}

export async function getSKUs(activeOnly = false): Promise<SKU[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.sku.v1.sKUs({ activeOnly });
  const converted = QuerySKUsResponseConverter.fromAmino(data as any);
  return converted.skus.map(fixSKUEnums);
}

export async function getSKU(uuid: string): Promise<SKU | null> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.sku.v1.sKU({ uuid }),
    null,
  );
  if (!data) return null;
  const converted = QuerySKUResponseConverter.fromAmino(data as any);
  return fixSKUEnums(converted.sku);
}

export async function getSKUsByProvider(providerUuid: string, activeOnly = false): Promise<SKU[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.sku.v1.sKUsByProvider({ providerUuid, activeOnly });
  const converted = QuerySKUsResponseConverter.fromAmino(data as any);
  return converted.skus.map(fixSKUEnums);
}

export async function getSKUParams(): Promise<SKUParams> {
  const client = await getQueryClient();
  const data = await client.liftedinit.sku.v1.params();
  const converted = QueryParamsResponseConverter.fromAmino(data as any);
  return converted.params;
}
