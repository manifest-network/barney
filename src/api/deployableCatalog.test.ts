import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDeployableCatalog, getDeployableProviders, getDeployableSKUs } from './deployableCatalog';
import { resolveSkuTiers } from './skuTiers';
import { getProviders, getSKUs, Unit, type Provider, type SKU } from './sku';
import { ProviderAllowlistError } from '../config/providerAllowlist';

const runtime = vi.hoisted(() => ({ allowlist: '' }));
vi.mock('../config/runtimeConfig', async (original) => {
  const actual = await original<typeof import('../config/runtimeConfig')>();
  return {
    ...actual,
    runtimeConfig: { ...actual.runtimeConfig, get PUBLIC_PROVIDER_ALLOWLIST() { return runtime.allowlist; } },
  };
});
vi.mock('./sku', async (original) => ({
  ...await original<typeof import('./sku')>(),
  getProviders: vi.fn(),
  getSKUs: vi.fn(),
}));
vi.mock('../utils/errors', () => ({ logError: vi.fn() }));

const MAINNET = 'https://barney.manifest.network/api/fred';
const providers = [
  { uuid: 'mainnet', apiUrl: `${MAINNET}/`, active: true },
  { uuid: 'aoraki', apiUrl: 'https://api.aoraki.manifest.network/api/fred', active: true },
  { uuid: 'morpheus', apiUrl: 'https://api.morpheus.manifest.network/api/fred', active: true },
] as Provider[];

function sku(providerUuid: string, name: string, amount: string): SKU {
  return {
    uuid: `${providerUuid}-${name}`, name, providerUuid, unit: Unit.UNIT_PER_HOUR,
    basePrice: { amount, denom: 'upwr' }, active: true,
  } as SKU;
}

const skus = [
  sku('mainnet', 'docker-micro', '50000'),
  sku('aoraki', 'docker-micro', '10000'),
  sku('morpheus', 'docker-large', '10000'),
  sku('inactive-provider', 'docker-small', '10000'),
];

beforeEach(() => {
  vi.clearAllMocks();
  runtime.allowlist = '';
  vi.mocked(getProviders).mockResolvedValue(providers);
  vi.mocked(getSKUs).mockResolvedValue(skus);
});

describe('deployable catalog', () => {
  it('is unchanged without an allowlist, and reads no providers just to list SKUs', async () => {
    await expect(getDeployableSKUs()).resolves.toEqual(skus);
    expect(getProviders).not.toHaveBeenCalled();
    await expect(getDeployableCatalog()).resolves.toEqual({ providers, skus });
    expect(getProviders).toHaveBeenCalledWith(true);
    expect(getSKUs).toHaveBeenCalledWith(true);
  });

  it('treats providers outside the allowlist, and their SKUs, as nonexistent', async () => {
    runtime.allowlist = JSON.stringify([MAINNET]);
    await expect(getDeployableProviders()).resolves.toEqual([providers[0]]);
    await expect(getDeployableSKUs()).resolves.toEqual([skus[0]]);
    await expect(getDeployableCatalog()).resolves.toEqual({ providers: [providers[0]], skus: [skus[0]] });
  });

  it('rejects an invalid allowlist before any chain read', async () => {
    runtime.allowlist = MAINNET;
    await expect(getDeployableProviders()).rejects.toBeInstanceOf(ProviderAllowlistError);
    await expect(getDeployableSKUs()).rejects.toBeInstanceOf(ProviderAllowlistError);
    expect(getProviders).not.toHaveBeenCalled();
    expect(getSKUs).not.toHaveBeenCalled();
  });
});

describe('resolveSkuTiers with an allowlist', () => {
  const specs = {
    'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
    'docker-large': { cores: 4, ramMB: 8192, diskGB: 40 },
  };

  it('selects the allowed provider even when another provider is cheaper', async () => {
    const unrestricted = await resolveSkuTiers(specs);
    expect(unrestricted.tiers.map((tier) => [tier.skuName, tier.providerUuid]))
      .toEqual([['docker-micro', 'aoraki'], ['docker-large', 'morpheus']]);

    runtime.allowlist = JSON.stringify([MAINNET]);
    const { tiers } = await resolveSkuTiers(specs);
    expect(tiers).toEqual([expect.objectContaining({
      skuName: 'docker-micro', skuUuid: 'mainnet-docker-micro', providerUuid: 'mainnet', pricePerHour: 0.05,
    })]);
  });

  it('offers no tier when no allowed provider is registered', async () => {
    runtime.allowlist = '["https://unregistered.example.com"]';
    await expect(resolveSkuTiers(specs)).resolves.toMatchObject({ tiers: [] });
  });
});
