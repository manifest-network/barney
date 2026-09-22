import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asAddress, type CosmosClientManager } from '@manifest-network/manifest-sdk';
import { buildManifestPreview } from '@manifest-network/manifest-sdk/catalog';
import {
  createProviderAuth, deployManifest, LeaseState, updateApp, waitForLeaseStatus,
  type FredLeaseRelease, type FredLeaseReleases,
} from '@manifest-network/manifest-sdk/deploy';
import { getCreditAccount } from '../../api/billing';
import { getLeaseProvision, getLeaseReleases } from '../../api/fred';
import { providerFetch } from '../../api/providerFetchAdapter';
import { getReadClient } from '../../api/readClient';
import { getProviders } from '../../api/sku';
import { MANIFEST_NOTICE_KEY } from '../../config/constants';
import { buildExampleManifest, EXAMPLE_APPS, findExampleByAppName } from '../../config/exampleApps';
import { fredCompatibilityForProvider } from '../../config/fredCompatibility';
import type { AppEntry } from '../../registry/appRegistry';
import {
  executeConfirmedDeployApp, executeConfirmedUpdateApp, executeDeployApp, executeUpdateApp,
} from './compositeTransactions';
import { resolveAppUrl } from './deployUrl';
import { makeRegistry } from './testHelpers';
import type { PayloadAttachment, SigningContext, ToolExecutorOptions } from './types';

// Keep plan validation and the update SDK real. Deployment stops at the SDK
// boundary, where its real preview validator checks the body before success.
vi.mock('@manifest-network/manifest-sdk/deploy', async (original) => {
  const actual = await original<typeof import('@manifest-network/manifest-sdk/deploy')>();
  return { ...actual, updateApp: vi.fn(actual.updateApp), deployManifest: vi.fn(), waitForLeaseStatus: vi.fn() };
});
vi.mock('../../api/billing', async (original) => ({
  ...await original<typeof import('../../api/billing')>(), getCreditAccount: vi.fn(),
}));
vi.mock('../../api/sku', async (original) => ({
  ...await original<typeof import('../../api/sku')>(), getProviders: vi.fn(),
}));
vi.mock('../../api/readClient', () => ({ getReadClient: vi.fn() }));
vi.mock('../../api/providerFetchAdapter', () => ({ providerFetch: vi.fn() }));
vi.mock('../../api/fred', async (original) => ({
  ...await original<typeof import('../../api/fred')>(), getLeaseProvision: vi.fn(), getLeaseReleases: vi.fn(),
}));
vi.mock('./deployUrl', async (original) => ({
  ...await original<typeof import('./deployUrl')>(), resolveAppUrl: vi.fn(),
}));

const ADDRESS = 'manifest1tenant';
const DEV = 'https://s049-u002.manifest0.net/api/fred';
const LEGACY = 'https://provider.example.com';
const chain = {} as CosmosClientManager;
const histories = new Map<string, FredLeaseReleases>();

function attachment(json: string): PayloadAttachment {
  const bytes = new TextEncoder().encode(json);
  return { bytes, filename: 'attached.json', size: bytes.length, hash: 'a'.repeat(64) };
}

function optionsFor(providerUrl: string, apps: AppEntry[] = []): ToolExecutorOptions {
  const providerAuth = createProviderAuth({
    getAddress: async () => asAddress(ADDRESS),
    getSigner: async () => { throw new Error('Update must not request a chain signer'); },
    signArbitrary: async () => ({
      pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'cHVia2V5' }, signature: 'c2lnbmF0dXJl',
    }),
  }, { chainId: 'manifest-dev' });
  vi.mocked(getProviders).mockResolvedValue([{ uuid: 'provider', apiUrl: providerUrl, active: true }] as never);
  return {
    address: ADDRESS, clientManager: chain, appRegistry: makeRegistry(apps),
    signing: {
      providerAuth,
      authTokens: { getAuthToken: (leaseUuid: string) => providerAuth.providerToken({ address: ADDRESS, leaseUuid }) },
    } as unknown as SigningContext,
    tiers: [{
      skuName: 'docker-micro', skuUuid: 'sku', providerUuid: 'provider', cores: 0.5,
      ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1,
    }],
  };
}

function releases(leaseUuid: string, latest = 1): FredLeaseReleases {
  const release = (version: number, status: string): FredLeaseRelease => ({
    version, status, image: 'nginx', created_at: '2026-09-22T12:00:00Z',
  });
  return {
    lease_uuid: leaseUuid, tenant: ADDRESS, provider_uuid: 'provider',
    releases: latest === 1 ? [release(1, 'active')] : [release(1, 'superseded'), release(2, 'active')],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  histories.clear();
  vi.mocked(getReadClient).mockResolvedValue({ query: {} } as Awaited<ReturnType<typeof getReadClient>>);
  vi.mocked(getCreditAccount).mockResolvedValue({ balances: [{ denom: 'upwr', amount: '1000000000' }] } as never);
  vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE, phase: 'ready' } as Awaited<ReturnType<typeof waitForLeaseStatus>>);
  vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'ready', fail_count: 0 });
  vi.mocked(getLeaseReleases).mockImplementation(async (_provider, leaseUuid) => histories.get(leaseUuid)!);
  vi.mocked(resolveAppUrl).mockResolvedValue({ url: 'https://app.example.com' });
  vi.mocked(deployManifest).mockImplementation(async (ctx, spec, callOptions) => {
    const providerUrl = (await getProviders())[0].apiUrl;
    const preview = await buildManifestPreview({ manifest: spec.manifest }, fredCompatibilityForProvider(providerUrl));
    expect(preview.validation).toMatchObject({ valid: true });
    expect(ctx.fredCompatibility).toBeDefined();
    const leaseUuid = crypto.randomUUID();
    await callOptions?.onLeaseCreated?.(leaseUuid, providerUrl);
    return { lease_uuid: leaseUuid, provider_url: providerUrl, state: LeaseState.LEASE_STATE_ACTIVE } as never;
  });
});

describe.each([DEV, LEGACY])('manifest confirmation on %s', (providerUrl) => {
  it('sends the merged approved update even when confirmation retains the original attachment', async () => {
    const previous = {
      image: 'nginx:1.27', env: { MODE: 'production' }, ports: { '80/tcp': {} },
      user: '1000:1000', tmpfs: ['/var/cache/nginx'],
    };
    const app: AppEntry = {
      name: 'example', leaseUuid: crypto.randomUUID(), providerUrl, providerUuid: 'provider',
      size: 'docker-micro', createdAt: 0, status: 'running', chainState: 'active',
      provisionState: 'confirmed', manifest: JSON.stringify(previous),
    };
    const options = optionsFor(providerUrl, [app]);
    histories.set(app.leaseUuid, releases(app.leaseUuid));
    vi.mocked(providerFetch).mockImplementation(async () => {
      histories.set(app.leaseUuid, releases(app.leaseUuid, 2));
      return new Response(JSON.stringify({ status: 'updating' }), { status: 202 });
    });
    const original = attachment('{"image":"nginx:1.28"}');
    const plan = await executeUpdateApp({ app_name: app.name }, options, original);
    expect(plan.success, plan.error).toBe(true);
    expect(plan.requiresConfirmation).toBe(true);
    const approvedManifest = plan.pendingAction!.args._generatedManifest as string;
    expect(JSON.parse(approvedManifest)).toEqual({ ...previous, image: 'nginx:1.28' });

    const result = await executeConfirmedUpdateApp(plan.pendingAction!.args, chain, options, original);
    expect(result.success).toBe(true);
    expect(vi.mocked(updateApp).mock.calls[0][1].manifest).toBe(approvedManifest);
    const sentBody = vi.mocked(providerFetch).mock.calls[0][1]?.body as string;
    expect(atob(JSON.parse(sentBody).payload)).toBe(approvedManifest);
    expect(JSON.parse(options.appRegistry!.getAppByLease(ADDRESS, app.leaseUuid)!.manifest!))
      .toEqual({ ...previous, image: 'nginx:1.28' });

    if (providerUrl === DEV) {
      const key = new Headers(vi.mocked(providerFetch).mock.calls[0][1]?.headers).get('Idempotency-Key');
      expect(key).toBe(plan.pendingAction!.args.idempotencyKey);
    }
  });

  it.each(EXAMPLE_APPS.filter((example) => example.notice))('deploys $label without uploading its display notice', async (example) => {
    const json = buildExampleManifest(example);
    const original = attachment(json);
    const options = optionsFor(providerUrl);
    const plan = await executeDeployApp({ app_name: 'render-example' }, options, original);
    expect(plan).toMatchObject({ success: true, requiresConfirmation: true });
    expect(plan.pendingAction!.args._generatedManifest).toBe(json);
    expect(JSON.parse(plan.pendingAction!.args._generatedManifest as string)[MANIFEST_NOTICE_KEY]).toBe(example.notice);

    const result = await executeConfirmedDeployApp(plan.pendingAction!.args, chain, options, original);
    expect(result.success).toBe(true);
    const uploaded = JSON.parse(vi.mocked(deployManifest).mock.calls[0][1].manifest);
    const expected = JSON.parse(json);
    delete expected[MANIFEST_NOTICE_KEY];
    expect(uploaded).toEqual(expected);
  });
});

it('normalizes the sidebar example fallback even without a generated manifest in the confirmation', async () => {
  // AppsSidebar uses this fallback when a stopped example has no stored manifest.
  const example = findExampleByAppName('manifest-render-dashboard')!;
  expect(example.notice).toBeDefined();
  const original = attachment(buildExampleManifest(example));
  const options = optionsFor(DEV);
  const plan = await executeDeployApp({ app_name: 'render-dashboard' }, options, original);
  expect(plan.requiresConfirmation).toBe(true);
  const args = { ...plan.pendingAction!.args };
  delete args._generatedManifest;
  expect((await executeConfirmedDeployApp(args, chain, options, original)).success).toBe(true);
  expect(JSON.parse(vi.mocked(deployManifest).mock.calls[0][1].manifest)).not.toHaveProperty(MANIFEST_NOTICE_KEY);
});

it('preserves approved recovery bytes even when an unrelated raw attachment is still present', async () => {
  const exact = '{ "image": "nginx:1.28", "env": { "MODE": "production" } }\n';
  const app: AppEntry = {
    name: 'example', leaseUuid: crypto.randomUUID(), providerUrl: DEV, providerUuid: 'provider',
    size: 'docker-micro', createdAt: 0, status: 'running', chainState: 'active',
    provisionState: 'confirmed', manifest: '{"image":"nginx:1.27"}',
  };
  const options = optionsFor(DEV, [app]);
  histories.set(app.leaseUuid, releases(app.leaseUuid));
  vi.mocked(providerFetch).mockRejectedValueOnce(new TypeError('Lost response'));
  const args = {
    app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: DEV,
    idempotencyKey: crypto.randomUUID(), _generatedManifest: exact,
  };
  expect((await executeConfirmedUpdateApp(args, chain, options)).success).toBe(false);
  const retry = await executeUpdateApp({ app_name: app.name }, options);
  expect(retry.pendingAction!.args._generatedManifest).toBe(exact);
  vi.mocked(providerFetch).mockImplementationOnce(async () => {
    histories.set(app.leaseUuid, releases(app.leaseUuid, 2));
    return new Response(JSON.stringify({ status: 'updating' }), { status: 202 });
  });
  const result = await executeConfirmedUpdateApp(retry.pendingAction!.args, chain, options, attachment('{"image":"redis"}'));
  expect(result.success).toBe(true);
  const calls = vi.mocked(providerFetch).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[1][1]?.body).toBe(calls[0][1]?.body);
  expect(atob(JSON.parse(calls[1][1]?.body as string).payload)).toBe(exact);
  expect(new Headers(calls[1][1]?.headers).get('Idempotency-Key')).toBe(args.idempotencyKey);
});
