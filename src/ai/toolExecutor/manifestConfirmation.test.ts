import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { validateManifestForProvider } from './deployArgs';
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
  // Exercise SDK fresh-auth sequencing without a real one-second wait per mint.
  let clock = Date.UTC(2026, 8, 23, 12);
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
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

afterEach(() => vi.restoreAllMocks());

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

it.each(['file', 'image', 'stack'] as const)('recovers a lost-response %s update after reload with identical key and upload bytes', async (source) => {
  const app: AppEntry = {
    name: 'example', leaseUuid: crypto.randomUUID(), providerUrl: DEV, providerUuid: 'provider',
    size: 'docker-micro', createdAt: 0, status: 'running', chainState: 'active',
    provisionState: 'confirmed', manifest: '{"image":"nginx:1.27","env":{"MODE":"production"},"user":"1000:1000","tmpfs":["/cache"]}',
  };
  const options = optionsFor(DEV, [app]);
  histories.set(app.leaseUuid, releases(app.leaseUuid));
  const file = source === 'file' ? attachment('{"image":"nginx:1.28"}') : undefined;
  const args = source === 'stack'
    ? { app_name: app.name, services: JSON.stringify({ web: { image: 'nginx:1.28', ports: '80', env: { PASSWORD: 'original-secret' } } }) }
    : source === 'image' ? { app_name: app.name, image: 'nginx:1.28' } : { app_name: app.name };
  const plan = await executeUpdateApp(args, options, file);
  expect(plan.requiresConfirmation, plan.error).toBe(true);
  const submitted = plan.pendingAction!.args._generatedManifest as string;
  vi.mocked(providerFetch).mockImplementationOnce(async () => {
    if (source !== 'file') {
      const observed = releases(app.leaseUuid, 2);
      histories.set(app.leaseUuid, { ...observed, releases: observed.releases.map((release) =>
        release.version === 2 ? { ...release, manifest: btoa(submitted) } : release) });
    }
    throw new TypeError('Accepted command response lost');
  });
  expect((await executeConfirmedUpdateApp(plan.pendingAction!.args, chain, options, file)).error).toContain('unconfirmed');

  vi.resetModules();
  const fresh = await import('./compositeTransactions');
  const state = await import('./maintenanceOperation');
  expect(state.getPendingMaintenanceOperation(ADDRESS, DEV, app.leaseUuid)?.manifest).toBeUndefined();
  const recovery = await fresh.executeUpdateApp({ app_name: app.name }, options, file);
  expect(recovery.requiresConfirmation, recovery.error).toBe(true);
  expect(recovery.pendingAction!.args).toMatchObject({
    _generatedManifest: submitted, _maintenanceRetry: true, idempotencyKey: plan.pendingAction!.args.idempotencyKey,
  });
  expect(providerFetch).toHaveBeenCalledTimes(1);
  expect(state.getPendingMaintenanceOperation(ADDRESS, DEV, app.leaseUuid)?.accepted).not.toBe(true);
  for (let index = 0; index < localStorage.length; index++) {
    expect(localStorage.getItem(localStorage.key(index)!)).not.toContain('original-secret');
  }
  vi.mocked(providerFetch).mockImplementationOnce(async () => {
    histories.set(app.leaseUuid, releases(app.leaseUuid, 2));
    return new Response(JSON.stringify({ status: 'updating' }), { status: 202 });
  });
  expect((await fresh.executeConfirmedUpdateApp(recovery.pendingAction!.args, chain, options, file)).success).toBe(true);
  const calls = vi.mocked(providerFetch).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[1][1]?.body).toBe(calls[0][1]?.body);
  expect(new Headers(calls[1][1]?.headers).get('Idempotency-Key')).toBe(new Headers(calls[0][1]?.headers).get('Idempotency-Key'));
  expect(state.getPendingMaintenanceOperation(ADDRESS, DEV, app.leaseUuid)).toBeUndefined();
});

it.each(['different release', 'no release after a rejected command'])('does not regenerate a lost payload with %s', async (scenario) => {
  vi.resetModules();
  const { executeUpdateApp: planUpdate } = await import('./compositeTransactions');
  const state = await import('./maintenanceOperation');
  const app: AppEntry = {
    name: 'example', leaseUuid: crypto.randomUUID(), providerUrl: DEV, providerUuid: 'provider',
    size: 'small', createdAt: 0, status: 'running', chainState: 'active', provisionState: 'confirmed',
    manifest: '{"image":"nginx:old"}',
  };
  const options = optionsFor(DEV, [app]);
  const saved = await state.getOrCreateMaintenanceOperation({
    address: ADDRESS, providerUrl: DEV, leaseUuid: app.leaseUuid, operation: 'update',
    manifest: '{"image":"nginx:new","env":{"PASSWORD":"unrecoverable-secret"}}', baselineReleaseVersions: [1],
  });
  const observed = releases(app.leaseUuid, scenario === 'different release' ? 2 : 1);
  histories.set(app.leaseUuid, { ...observed, releases: observed.releases.map((release) =>
    release.version === 2 ? { ...release, manifest: btoa('{"image":"nginx:new","env":{"PASSWORD":"different-secret"}}') } : release) });
  vi.resetModules();
  const fresh = await import('./compositeTransactions');
  const result = await fresh.executeUpdateApp({ app_name: app.name }, options);
  expect(result.requiresConfirmation).not.toBe(true);
  expect(result.error).toContain('exact submitted payload could not be recovered');
  expect(result.error).toContain('separately confirmed stop_app to end this deployment');
  expect(result.error).toContain('Fred may execute the old command until the lease closes');
  expect(providerFetch).not.toHaveBeenCalled();
  expect((await import('./maintenanceOperation')).getPendingMaintenanceOperation(ADDRESS, DEV, app.leaseUuid)?.idempotencyKey).toBe(saved.idempotencyKey);
  // The old module still retains the exact bytes. A replacement attachment
  // cannot repurpose the key or hide that valid recovery source.
  const mismatched = await planUpdate({ app_name: app.name }, options, attachment('{"image":"redis"}'));
  expect(mismatched.requiresConfirmation, mismatched.error).toBe(true);
  expect(mismatched.pendingAction?.args).toMatchObject({ idempotencyKey: saved.idempotencyKey,
    _generatedManifest: saved.manifest, _maintenanceRetry: true });
  // A reloaded module with neither retained bytes nor matching history still refuses.
  const unavailable = await fresh.executeUpdateApp({ app_name: app.name }, options, attachment('{"image":"redis"}'));
  expect(unavailable.requiresConfirmation).not.toBe(true);
  expect(unavailable.error).toContain('Release history was read successfully but contained no matching manifest');
});

it.each(['memory', 'history'] as const)('recovers exact bytes from %s even when the same turn keeps supplying a mismatched attachment', async source => {
  const app: AppEntry = {
    name: 'example', leaseUuid: crypto.randomUUID(), providerUrl: DEV, providerUuid: 'provider',
    size: 'small', createdAt: 0, status: 'running', chainState: 'active', provisionState: 'confirmed',
    manifest: '{"image":"nginx:old"}',
  };
  const options = optionsFor(DEV, [app]);
  histories.set(app.leaseUuid, releases(app.leaseUuid));
  const plan = await executeUpdateApp({ app_name: app.name, image: 'nginx:new' }, options);
  expect(plan.requiresConfirmation, plan.error).toBe(true);
  const manifest = plan.pendingAction!.args._generatedManifest as string;
  vi.mocked(providerFetch).mockImplementationOnce(async () => {
    const observed = releases(app.leaseUuid, 2);
    histories.set(app.leaseUuid, { ...observed, releases: observed.releases.map(release =>
      release.version === 2 ? { ...release, manifest: btoa(manifest) } : release) });
    throw new TypeError('Accepted response lost');
  });
  expect((await executeConfirmedUpdateApp(plan.pendingAction!.args, chain, options)).error).toContain('unconfirmed');
  const firstRequest = vi.mocked(providerFetch).mock.calls[0][1]!;
  const historyReads = vi.mocked(getLeaseReleases).mock.calls.length;
  if (source === 'history') vi.resetModules();
  const actions = source === 'memory' ? { executeUpdateApp, executeConfirmedUpdateApp }
    : await import('./compositeTransactions');
  const turnAttachment = attachment('{"image":"redis:wrong"}');
  for (let call = 0; call < 2; call++) {
    const recovery = await actions.executeUpdateApp({ app_name: app.name }, options, turnAttachment);
    expect(recovery.requiresConfirmation, recovery.error).toBe(true);
    expect(recovery.confirmationMessage).toContain('The attached file was not used; this confirms the previously submitted update.');
    expect(recovery.pendingAction?.args).toMatchObject({
      _generatedManifest: manifest, _maintenanceRetry: true, idempotencyKey: plan.pendingAction!.args.idempotencyKey,
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  }
  if (source === 'memory') expect(getLeaseReleases).toHaveBeenCalledTimes(historyReads);
  else expect(getLeaseReleases).toHaveBeenCalledTimes(historyReads + 2);

  const recovery = await actions.executeUpdateApp({ app_name: app.name }, options, turnAttachment);
  vi.mocked(providerFetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: 'updating' }), { status: 202 }));
  const result = await actions.executeConfirmedUpdateApp(recovery.pendingAction!.args, chain, options, turnAttachment);
  expect(result.success, result.error).toBe(true);
  expect(result.data).toMatchObject({ attachmentUnused: true, message: expect.stringContaining('The attached file was not used') });
  const recoveredRequest = vi.mocked(providerFetch).mock.calls[1][1]!;
  expect(recoveredRequest.body).toBe(firstRequest.body);
  expect(new Headers(recoveredRequest.headers).get('Idempotency-Key')).toBe(new Headers(firstRequest.headers).get('Idempotency-Key'));
});

it('preserves the complete legacy SDK validation list for edits made at confirmation', async () => {
  const app: AppEntry = { name: 'web', leaseUuid: crypto.randomUUID(), providerUrl: LEGACY,
    providerUuid: 'provider', size: 'small', createdAt: 0, status: 'running', chainState: 'active', provisionState: 'confirmed', manifest: '{"image":"nginx"}' };
  const options = optionsFor(LEGACY, [app]);
  const plan = await executeUpdateApp({ app_name: app.name, image: 'nginx' }, options);
  expect(plan.requiresConfirmation, plan.error).toBe(true);
  const invalid = JSON.stringify({ services: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
    `web${index}`, { image: 123 },
  ])) });
  const detail = await validateManifestForProvider(invalid, LEGACY);
  expect(detail!.length).toBeGreaterThan(256);
  const result = await executeConfirmedUpdateApp({ ...plan.pendingAction!.args, _generatedManifest: invalid }, chain, options);
  expect(result.error).toBe(`Update failed: ${detail}`);
  expect(providerFetch).not.toHaveBeenCalled();
});

it('keeps exact-payload recovery guidance when signing the history read is rejected', async () => {
  vi.resetModules();
  const state = await import('./maintenanceOperation');
  const app: AppEntry = {
    name: 'example', leaseUuid: crypto.randomUUID(), providerUrl: DEV, providerUuid: 'provider',
    size: 'small', createdAt: 0, status: 'running', chainState: 'active', provisionState: 'confirmed',
    manifest: '{"image":"nginx:old"}',
  };
  const options = optionsFor(DEV, [app]);
  const saved = await state.getOrCreateMaintenanceOperation({
    address: ADDRESS, providerUrl: DEV, leaseUuid: app.leaseUuid, operation: 'update',
    manifest: '{"image":"nginx:new","env":{"PASSWORD":"lost-secret"}}', baselineReleaseVersions: [1],
  });
  vi.resetModules();
  const fresh = await import('./compositeTransactions');
  vi.spyOn(options.signing!.authTokens, 'getAuthToken').mockRejectedValue(new Error('Wallet rejected: private diagnostic'));
  const result = await fresh.executeUpdateApp({ app_name: app.name }, options);
  expect(result.requiresConfirmation).not.toBe(true);
  expect(result.error).toContain('exact submitted payload could not be recovered');
  expect(result.error).toContain('exact reviewed manifest');
  expect(result.error).not.toContain('private diagnostic');
  expect(result.error).not.toContain('recovered from provider release history');
  expect(result.error).toContain('Release history could not be read');
  expect(result.error).not.toContain('stop_app');
  expect(getLeaseReleases).not.toHaveBeenCalled();
  expect(providerFetch).not.toHaveBeenCalled();
  expect((await import('./maintenanceOperation')).getPendingMaintenanceOperation(ADDRESS, DEV, app.leaseUuid)?.idempotencyKey).toBe(saved.idempotencyKey);
});

it('recovers an accepted update after a temporary history failure without suggesting a stop', async () => {
  const app: AppEntry = {
    name: 'healthy-service', leaseUuid: crypto.randomUUID(), providerUrl: DEV, providerUuid: 'provider',
    size: 'small', createdAt: 0, status: 'running', chainState: 'active', provisionState: 'confirmed',
    manifest: '{"image":"nginx:old"}',
  };
  const options = optionsFor(DEV, [app]);
  histories.set(app.leaseUuid, releases(app.leaseUuid));
  const plan = await executeUpdateApp({ app_name: app.name, image: 'nginx:new', ports: '8080' }, options);
  expect(plan.requiresConfirmation, plan.error).toBe(true);
  const manifest = plan.pendingAction!.args._generatedManifest as string;
  vi.mocked(providerFetch).mockImplementationOnce(async () => {
    const observed = releases(app.leaseUuid, 2);
    histories.set(app.leaseUuid, { ...observed, releases: observed.releases.map((release) =>
      release.version === 2 ? { ...release, manifest: btoa(manifest) } : release) });
    throw new TypeError('Accepted 202 response was lost');
  });
  expect((await executeConfirmedUpdateApp(plan.pendingAction!.args, chain, options)).error).toContain('unconfirmed');
  const originalRequest = vi.mocked(providerFetch).mock.calls[0][1];

  vi.resetModules();
  const fresh = await import('./compositeTransactions');
  vi.mocked(getLeaseReleases).mockRejectedValueOnce(new TypeError('Transient history failure with private diagnostics'));
  const unavailable = await fresh.executeUpdateApp({ app_name: app.name }, options);
  expect(unavailable.requiresConfirmation).not.toBe(true);
  expect(unavailable.error).toContain('Release history could not be read');
  expect(unavailable.error).toContain('matching bytes may still be recoverable');
  expect(unavailable.error).not.toMatch(/stop_app|only in-app exit|private diagnostics/);
  expect(options.appRegistry!.getAppByLease(ADDRESS, app.leaseUuid)?.provisionState).toBe('confirmed');
  expect(providerFetch).toHaveBeenCalledTimes(1);

  const recovery = await fresh.executeUpdateApp({ app_name: app.name }, options);
  expect(recovery.requiresConfirmation, recovery.error).toBe(true);
  expect(recovery.pendingAction!.args).toMatchObject({
    idempotencyKey: plan.pendingAction!.args.idempotencyKey, _generatedManifest: manifest, _maintenanceRetry: true,
  });
  vi.mocked(providerFetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: 'updating' }), { status: 202 }));
  expect((await fresh.executeConfirmedUpdateApp(recovery.pendingAction!.args, chain, options)).success).toBe(true);
  const retryRequest = vi.mocked(providerFetch).mock.calls[1][1];
  expect(retryRequest?.body).toBe(originalRequest?.body);
  expect(new Headers(retryRequest?.headers).get('Idempotency-Key')).toBe(new Headers(originalRequest?.headers).get('Idempotency-Key'));
});

it.each(['restart', 'update'] as const)('does not borrow a %s key introduced by another tab during update planning', async (operation) => {
  vi.resetModules();
  const state = await import('./maintenanceOperation');
  const app: AppEntry = {
    name: 'example', leaseUuid: crypto.randomUUID(), providerUrl: DEV, providerUuid: 'provider',
    size: 'small', createdAt: 0, status: 'running', chainState: 'active', provisionState: 'confirmed',
    manifest: '{"image":"nginx:old"}',
  };
  const options = optionsFor(DEV, [app]);
  const command = await state.getOrCreateMaintenanceOperation({
    address: ADDRESS, providerUrl: DEV, leaseUuid: app.leaseUuid, operation,
    ...(operation === 'update' && { manifest: '{"image":"nginx:other"}' }), baselineReleaseVersions: [1],
  });
  const storageKey = localStorage.key(0)!;
  const metadata = localStorage.getItem(storageKey)!;
  localStorage.removeItem(storageKey);
  // A second module instance models a separate tab with no copy of the first
  // tab's in-memory pending command. Hydration must observe the storage change.
  vi.resetModules();
  const { executeUpdateApp: planUpdate } = await import('./compositeTransactions');
  const planning = planUpdate({ app_name: app.name }, options, attachment('{"image":"nginx:new"}'));
  localStorage.setItem(storageKey, metadata);
  const result = await planning;
  expect(result.requiresConfirmation).not.toBe(true);
  expect(result.error).toContain('became unresolved while planning');
  expect(result.error).toContain(`Recover that saved ${operation}`);
  expect(state.getPendingMaintenanceOperation(ADDRESS, DEV, app.leaseUuid)).toMatchObject({
    idempotencyKey: command.idempotencyKey, recoveryAdvised: true,
  });
  const { getMaintenanceRecoveryIntent } = await import('./maintenanceRecoveryIntent');
  expect(getMaintenanceRecoveryIntent({ address: ADDRESS, providerUrl: DEV, leaseUuid: app.leaseUuid })?.idempotencyKey).toBe(command.idempotencyKey);
  await state.completeMaintenanceOperation(command, undefined, 'succeeded');
  expect((await planUpdate({ app_name: app.name }, options, attachment('{"image":"nginx:new"}'))).error).toContain('has already settled');
  expect(providerFetch).not.toHaveBeenCalled();
});
