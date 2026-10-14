/**
 * ENG-1457: every new-deployment path (SKU tiers, deploy and batch planning,
 * browse_catalog) reads the catalog through these. Providers outside
 * PUBLIC_PROVIDER_ALLOWLIST are treated as nonexistent. Each reader throws
 * ProviderAllowlistError for an invalid setting so callers can report it.
 */

import { getProviders, getSKUs } from './sku';
import type { Provider, SKU } from './sku';
import { getProviderAllowlist, isProviderAllowed } from '../config/providerAllowlist';

/** Active providers this deployment may deploy to. */
export async function getDeployableProviders(): Promise<Provider[]> {
  const allowlist = getProviderAllowlist();
  const providers = await getProviders(true);
  return allowlist ? providers.filter((provider) => isProviderAllowed(provider.apiUrl)) : providers;
}

/** Deployable providers with their active SKUs. Unrestricted, the SKU list is
 * unchanged: it may name providers missing from the active provider list. */
export async function getDeployableCatalog(): Promise<{ providers: Provider[]; skus: SKU[] }> {
  const [providers, skus] = await Promise.all([getDeployableProviders(), getSKUs(true)]);
  if (!getProviderAllowlist()) return { providers, skus };
  const allowed = new Set(providers.map((provider) => provider.uuid));
  return { providers, skus: skus.filter((sku) => allowed.has(sku.providerUuid)) };
}

/** Active SKUs offered by deployable providers, without a provider read when unrestricted. */
export async function getDeployableSKUs(): Promise<SKU[]> {
  return getProviderAllowlist() ? (await getDeployableCatalog()).skus : getSKUs(true);
}
