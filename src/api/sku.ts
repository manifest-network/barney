import { liftedinit } from '@manifest-network/manifestjs';
import type {
  Provider,
  SKU,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/sku/v1/types';
import { getReadClient } from './readClient';

// Re-export manifestjs types for consumers
export type { Provider, SKU };

// Re-export Unit enum from manifestjs for type safety
export const Unit = liftedinit.sku.v1.Unit;
export type Unit = (typeof Unit)[keyof typeof Unit];

// Reads run over the cached read client (LCD transport preserves the numeric
// `unit` enum natively, so the old fixSKUEnums/unitFromJSON re-map is gone).
// That numeric-`unit` guarantee lives upstream in the SDK read client's LCD
// adapter, which decodes SKUs via manifestjs `SKU.fromJSON` (→ `unitFromJSON`,
// which maps "UNIT_PER_DAY" → the numeric enum) — NOT `fromAmino`, which left
// `unit` a string and was the reason `fixSKUEnums` existed. If the SDK ever
// regressed this read path back to a string `unit`, `hourlyPriceFromSku`'s
// PER_DAY `/24` branch would silently stop matching and mis-price by 24×.
// getSKUs/getProviders return BrandedSKU[]/BrandedProvider[]; branded ⊆ plain,
// so the widened SKU[]/Provider[] return types stay assignable with no cast.
export async function getProviders(activeOnly = false): Promise<Provider[]> {
  const client = await getReadClient();
  return client.getProviders({ activeOnly });
}

export async function getSKUs(activeOnly = false): Promise<SKU[]> {
  const client = await getReadClient();
  return client.getSKUs({ activeOnly });
}
