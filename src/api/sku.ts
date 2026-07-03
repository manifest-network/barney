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
