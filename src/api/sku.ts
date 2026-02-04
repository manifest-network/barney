import { liftedinit } from '@manifest-network/manifestjs';
import type {
  Params as SKUParams,
  Provider,
  SKU,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/sku/v1/types';
import { getQueryClient, queryWithNotFound, lcdConvert, fixEnumField } from './queryClient';

// Re-export manifestjs types for consumers
export type { SKUParams, Provider, SKU };

// Re-export Unit enum from manifestjs for type safety
export const Unit = liftedinit.sku.v1.Unit;
export type Unit = (typeof Unit)[keyof typeof Unit];

// Conversion function from manifestjs (used by fixSKUEnums)
const { unitFromJSON: fromJSON } = liftedinit.sku.v1;

// fromAmino converters for query responses
const {
  QueryParamsResponse: QueryParamsResponseConverter,
  QueryProviderResponse: QueryProviderResponseConverter,
  QueryProvidersResponse: QueryProvidersResponseConverter,
  QuerySKUResponse: QuerySKUResponseConverter,
  QuerySKUsResponse: QuerySKUsResponseConverter,
} = liftedinit.sku.v1;

// fromAmino doesn't convert enum strings to numeric values; LCD returns strings like "UNIT_PER_HOUR"
// but Unit enum keys are numeric (0, 1, 2, ...). This fixes the mismatch.
function fixSKUEnums(sku: SKU): SKU {
  return fixEnumField(sku, 'unit', fromJSON);
}

export async function getProviders(activeOnly = false): Promise<Provider[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.sku.v1.providers({ activeOnly });
  return lcdConvert(data, QueryProvidersResponseConverter).providers;
}

export async function getProvider(uuid: string): Promise<Provider | null> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.sku.v1.provider({ uuid }),
    null,
  );
  if (!data) return null;
  return lcdConvert(data, QueryProviderResponseConverter).provider;
}

export async function getSKUs(activeOnly = false): Promise<SKU[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.sku.v1.sKUs({ activeOnly });
  return lcdConvert(data, QuerySKUsResponseConverter).skus.map(fixSKUEnums);
}

export async function getSKU(uuid: string): Promise<SKU | null> {
  const client = await getQueryClient();
  const data = await queryWithNotFound(
    () => client.liftedinit.sku.v1.sKU({ uuid }),
    null,
  );
  if (!data) return null;
  return fixSKUEnums(lcdConvert(data, QuerySKUResponseConverter).sku);
}

export async function getSKUsByProvider(providerUuid: string, activeOnly = false): Promise<SKU[]> {
  const client = await getQueryClient();
  const data = await client.liftedinit.sku.v1.sKUsByProvider({ providerUuid, activeOnly });
  return lcdConvert(data, QuerySKUsResponseConverter).skus.map(fixSKUEnums);
}

export async function getSKUParams(): Promise<SKUParams> {
  const client = await getQueryClient();
  const data = await client.liftedinit.sku.v1.params();
  return lcdConvert(data, QueryParamsResponseConverter).params;
}
