/**
 * ENG-1457: with PUBLIC_PROVIDER_ALLOWLIST set, every tool path treats other
 * providers, and apps on them, as nonexistent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deployManifest, restartApp, stopApp, updateApp } from '@manifest-network/manifest-sdk/deploy';
import type { CosmosClientManager } from '@manifest-network/manifest-sdk';
import { getCreditAccount } from '../../api/billing';
import { getReadClient } from '../../api/readClient';
import { getProviderHealth } from '../../api/provider-api';
import { getProviders, getSKUs, Unit, type Provider, type SKU } from '../../api/sku';
import type { ResolvedSkuTier } from '../../api/skuTiers';
import * as appRegistry from '../../registry/appRegistry';
import { executeBrowseCatalog } from './compositeQueries';
import {
  executeConfirmedDeployApp,
  executeDeployApp,
  executeRestartApp,
  executeStopApp,
  executeUpdateApp,
} from './compositeTransactions';
import { planBatchDeploy } from './batchDeployPlan';
import { buildBarneyCtx, ProviderNotAllowedError } from './capabilityCtx';
import type { SigningContext, ToolExecutorOptions } from './types';

const runtime = vi.hoisted(() => ({ allowlist: '' }));
vi.mock('../../config/runtimeConfig', async (original) => {
  const actual = await original<typeof import('../../config/runtimeConfig')>();
  return {
    ...actual,
    runtimeConfig: { ...actual.runtimeConfig, get PUBLIC_PROVIDER_ALLOWLIST() { return runtime.allowlist; } },
  };
});
vi.mock('../../api/sku', async (original) => ({
  ...await original<typeof import('../../api/sku')>(), getProviders: vi.fn(), getSKUs: vi.fn(),
}));
vi.mock('../../api/billing', async (original) => ({
  ...await original<typeof import('../../api/billing')>(), getCreditAccount: vi.fn(),
}));
vi.mock('../../api/provider-api', async (original) => ({
  ...await original<typeof import('../../api/provider-api')>(), getProviderHealth: vi.fn(),
}));
vi.mock('@manifest-network/manifest-sdk/deploy', async (original) => ({
  ...await original<typeof import('@manifest-network/manifest-sdk/deploy')>(),
  deployManifest: vi.fn(), restartApp: vi.fn(), stopApp: vi.fn(), updateApp: vi.fn(),
}));
vi.mock('../../api/readClient', () => ({ getReadClient: vi.fn() }));
vi.mock('../../utils/errors', () => ({ logError: vi.fn() }));

const MAINNET_URL = 'https://barney.manifest.network/api/fred';
const AORAKI_URL = 'https://api.aoraki.manifest.network/api/fred';
const MAINNET = '550e8400-e29b-41d4-a716-446655440001';
const AORAKI = '550e8400-e29b-41d4-a716-446655440002';

function sku(providerUuid: string, amount: string): SKU {
  return {
    uuid: `${providerUuid}-sku`, name: 'docker-micro', providerUuid, unit: Unit.UNIT_PER_HOUR,
    basePrice: { amount, denom: 'upwr' }, active: true,
  } as SKU;
}

function tier(providerUuid: string): ResolvedSkuTier {
  return {
    skuName: 'docker-micro', skuUuid: `${providerUuid}-sku`, providerUuid,
    cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.01, denomSymbol: 'PWR', unit: Unit.UNIT_PER_HOUR,
  };
}

let address: string;
let sequence = 0;

function options(overrides: Partial<ToolExecutorOptions> = {}): ToolExecutorOptions {
  return { address, appRegistry, clientManager: null, tiers: [tier(MAINNET)], ...overrides };
}

function addApp(name: string, leaseUuid: string, providerUuid: string, providerUrl: string): void {
  appRegistry.addApp(address, {
    name, leaseUuid, providerUuid, providerUrl, size: 'docker-micro', createdAt: 1,
    status: 'running', chainState: 'active', provisionState: 'confirmed', manifest: '{"image":"nginx"}',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.allowlist = JSON.stringify([MAINNET_URL]);
  address = `manifest1allowlist${++sequence}`;
  vi.mocked(getProviders).mockResolvedValue([
    { uuid: MAINNET, apiUrl: MAINNET_URL, active: true },
    { uuid: AORAKI, apiUrl: AORAKI_URL, active: true },
  ] as Provider[]);
  // Aoraki is cheaper, so an unrestricted catalog would select it.
  vi.mocked(getSKUs).mockResolvedValue([sku(MAINNET, '50000'), sku(AORAKI, '10000')]);
  vi.mocked(getCreditAccount).mockResolvedValue({
    balances: [{ denom: 'upwr', amount: '1000000000' }],
  } as unknown as Awaited<ReturnType<typeof getCreditAccount>>);
  vi.mocked(getProviderHealth).mockResolvedValue({ status: 'healthy', provider_uuid: MAINNET } as Awaited<ReturnType<typeof getProviderHealth>>);
});

describe('catalog and deploy paths', () => {
  it('browse_catalog lists and health-checks only allowed providers and their SKUs', async () => {
    const result = await executeBrowseCatalog();
    expect(result.success).toBe(true);
    const data = result.data as { providers: { uuid: string }[]; tiers: Record<string, { provider: string }[]> };
    expect(data.providers.map((provider) => provider.uuid)).toEqual([MAINNET]);
    expect(data.tiers['docker-micro'].map((row) => row.provider)).toEqual([MAINNET]);
    expect(getProviderHealth).toHaveBeenCalledTimes(1);
    expect(getProviderHealth).toHaveBeenCalledWith(MAINNET_URL);
  });

  it('deploy_app plans on the allowed provider and finds no other one', async () => {
    const planned = await executeDeployApp({ image: 'nginx:1.27', app_name: 'web' }, options());
    expect(planned).toMatchObject({
      requiresConfirmation: true,
      pendingAction: { args: { providerUuid: MAINNET, providerUrl: MAINNET_URL } },
    });

    const refused = await executeDeployApp({ image: 'nginx:1.27', app_name: 'web' }, options({ tiers: [tier(AORAKI)] }));
    expect(refused).toEqual({ success: false, error: 'No available provider found for this tier.' });
  });

  it('confirmed deploy refuses a plan naming another provider before any transaction', async () => {
    const bytes = new TextEncoder().encode('{"image":"nginx"}');
    const result = await executeConfirmedDeployApp(
      { app_name: 'web', size: 'docker-micro', skuUuid: `${AORAKI}-sku`, providerUuid: AORAKI, providerUrl: AORAKI_URL },
      {} as CosmosClientManager,
      options({ signing: {} as SigningContext }),
      { bytes, size: bytes.length, hash: '' },
    );
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('No transaction was submitted') });
    expect(deployManifest).not.toHaveBeenCalled();
  });

  it('batch planning refreshes tiers to the allowed provider even if the session catalog named another', async () => {
    const bytes = new TextEncoder().encode('{"image":"nginx"}');
    const result = await planBatchDeploy(
      [{ app_name: 'web', size: 'docker-micro', payload: { bytes, size: bytes.length, hash: '' } }],
      options({ tiers: [tier(AORAKI)] }),
    );
    if (!result.success) throw new Error(result.error);
    expect(result.plan.entries).toEqual([expect.objectContaining({ providerUuid: MAINNET, providerUrl: MAINNET_URL })]);
  });

  it('reports an invalid allowlist instead of a transient provider failure', async () => {
    runtime.allowlist = MAINNET_URL;
    const result = await executeDeployApp({ image: 'nginx:1.27', app_name: 'web' }, options());
    expect(result).toEqual({ success: false, error: expect.stringContaining('PUBLIC_PROVIDER_ALLOWLIST') });
    await expect(executeBrowseCatalog()).rejects.toThrow('PUBLIC_PROVIDER_ALLOWLIST');
  });
});

describe('provider URLs the SDK resolves from chain', () => {
  /** The read client's provider lookup, with `chainUrls` as the on-chain api_url per provider. */
  function readClient(chainUrls: Record<string, string>) {
    const billing = { v1: {} };
    const v1 = {
      provider: vi.fn(async ({ uuid }: { uuid: string }) => ({ provider: { uuid, apiUrl: chainUrls[uuid] } })),
      providers: vi.fn(),
    };
    const query = { liftedinit: { billing, sku: { v1 } } };
    vi.mocked(getReadClient).mockResolvedValue({ query } as unknown as Awaited<ReturnType<typeof getReadClient>>);
    return { query, v1 };
  }

  it('rejects a lookup resolving outside the allowlist and leaves the rest of the query client untouched', async () => {
    const { query, v1 } = readClient({ [MAINNET]: `${MAINNET_URL}/`, [AORAKI]: AORAKI_URL });
    const ctx = await buildBarneyCtx({} as CosmosClientManager, { providerAuth: {} } as SigningContext);
    const sku = ctx.query.liftedinit.sku.v1;
    await expect(sku.provider({ uuid: MAINNET })).resolves.toMatchObject({ provider: { apiUrl: `${MAINNET_URL}/` } });
    await expect(sku.provider({ uuid: AORAKI })).rejects.toBeInstanceOf(ProviderNotAllowedError);
    expect(sku.providers).toBe(v1.providers);
    expect(ctx.query.liftedinit.billing).toBe(query.liftedinit.billing);

    runtime.allowlist = '';
    expect((await buildBarneyCtx({} as CosmosClientManager, { providerAuth: {} } as SigningContext)).query).toBe(query);
  });

  it('stops a confirmed deploy before create-lease when the planned provider changed its URL on chain', async () => {
    const actual = await vi.importActual<typeof import('@manifest-network/manifest-sdk/deploy')>('@manifest-network/manifest-sdk/deploy');
    vi.mocked(deployManifest).mockImplementation(actual.deployManifest);
    // Planned with mainnet's URL; the provider's on-chain api_url changed since.
    readClient({ [MAINNET]: AORAKI_URL });
    const chain = {
      getAddress: vi.fn().mockResolvedValue(address),
      acquireRateLimit: vi.fn().mockResolvedValue(undefined),
      getSigningClient: vi.fn(),
      withBroadcastLock: vi.fn(),
    };
    const providerAuth = { providerToken: vi.fn(), leaseDataToken: vi.fn() };
    const bytes = new TextEncoder().encode('{"image":"nginx:1.27","ports":{"80/tcp":{}}}');

    const result = await executeConfirmedDeployApp(
      { app_name: 'web', size: 'docker-micro', skuUuid: `${MAINNET}-sku`, providerUuid: MAINNET, providerUrl: MAINNET_URL },
      chain as unknown as CosmosClientManager,
      options({ signing: { providerAuth } as unknown as SigningContext }),
      { bytes, size: bytes.length, hash: '' },
    );
    expect(result).toEqual({
      success: false,
      error: `Provider ${MAINNET} is not offered by this deployment. No transaction was submitted.`,
    });
    expect(deployManifest).toHaveBeenCalledTimes(1);
    expect(chain.getSigningClient).not.toHaveBeenCalled();
    expect(chain.withBroadcastLock).not.toHaveBeenCalled();
    expect(providerAuth.leaseDataToken).not.toHaveBeenCalled();
    expect(appRegistry.getApps(address, { includeHidden: true })).toEqual([]);
  });
});

describe('apps on other providers', () => {
  const MAINNET_LEASE = '550e8400-e29b-41d4-a716-446655440010';
  const AORAKI_LEASE = '550e8400-e29b-41d4-a716-446655440011';

  beforeEach(() => {
    runtime.allowlist = '';
    addApp('mainnet-app', MAINNET_LEASE, MAINNET, MAINNET_URL);
    addApp('aoraki-app', AORAKI_LEASE, AORAKI, AORAKI_URL);
    runtime.allowlist = JSON.stringify([MAINNET_URL]);
  });

  it.each([
    ['restart_app', () => executeRestartApp({ app_name: 'aoraki-app' }, options())],
    ['update_app', () => executeUpdateApp({ app_name: 'aoraki-app', image: 'nginx:1.28' }, options())],
    ['stop_app', () => executeStopApp({ app_name: 'aoraki-app' }, options())],
  ])('%s does not find them', async (_tool, run) => {
    await expect(run()).resolves.toMatchObject({ success: false, error: expect.stringContaining('aoraki-app') });
    expect(restartApp).not.toHaveBeenCalled();
    expect(updateApp).not.toHaveBeenCalled();
    expect(stopApp).not.toHaveBeenCalled();
  });

  it('keeps their names reserved, so names stay unambiguous if they reappear', async () => {
    const planned = await executeDeployApp({ image: 'nginx:1.27', app_name: 'aoraki-app' }, options());
    expect(planned).toMatchObject({ pendingAction: { args: { app_name: 'aoraki-app-2', providerUrl: MAINNET_URL } } });
  });

  it('"all" selections cover only apps on allowed providers', async () => {
    const restart = await executeRestartApp({ app_name: 'all' }, options());
    expect(restart).toMatchObject({ requiresConfirmation: true });
    expect(JSON.stringify(restart.pendingAction?.args)).not.toContain(AORAKI_LEASE);
    expect(restart.pendingAction?.args).toMatchObject({ entries: [{ leaseUuid: MAINNET_LEASE }] });
  });
});
