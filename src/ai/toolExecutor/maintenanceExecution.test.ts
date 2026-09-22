import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asAddress, type CosmosClientManager } from '@manifest-network/manifest-sdk';
import {
  createProviderAuth, LeaseState, restartApp, updateApp, waitForLeaseStatus,
  type FredLeaseProvision, type FredLeaseRelease, type FredLeaseReleases,
} from '@manifest-network/manifest-sdk/deploy';
import { getReadClient } from '../../api/readClient';
import { providerFetch } from '../../api/providerFetchAdapter';
import { getLeaseProvision, getLeaseReleases } from '../../api/fred';
import type { AppEntry } from '../../registry/appRegistry';
import { resolveAppUrl } from './deployUrl';
import { executeConfirmedRestartApp, executeConfirmedUpdateApp, executeRestartApp, executeUpdateApp } from './compositeTransactions';
import { completeMaintenanceOperation, getOrCreateMaintenanceOperation, getPendingMaintenanceOperation } from './maintenanceOperation';
import { reconcilePendingMaintenance } from './maintenanceReconciliation';
import { makeRegistry } from './testHelpers';
import type { SigningContext, ToolExecutorOptions } from './types';

// Exercise the real SDK's request construction, error classification and fresh
// authentication. Only provider I/O and the independent readiness observation
// are controlled; no wallet, chain, or provider is contacted.
vi.mock('@manifest-network/manifest-sdk/deploy', async (original) => {
  const actual = await original<typeof import('@manifest-network/manifest-sdk/deploy')>();
  return { ...actual, restartApp: vi.fn(actual.restartApp), updateApp: vi.fn(actual.updateApp), waitForLeaseStatus: vi.fn() };
});
vi.mock('../../api/readClient', () => ({ getReadClient: vi.fn() }));
vi.mock('../../api/providerFetchAdapter', () => ({ providerFetch: vi.fn() }));
vi.mock('../../api/fred', async (original) => ({
  ...await original<typeof import('../../api/fred')>(), getLeaseProvision: vi.fn(), getLeaseReleases: vi.fn(),
}));
vi.mock('./deployUrl', async (original) => ({
  ...await original<typeof import('./deployUrl')>(), resolveAppUrl: vi.fn(),
}));

const PROVIDER = 'https://s049-u002.manifest0.net/api/fred';
const ADDRESS = 'manifest1tenant';
const OLD_MANIFEST = '{"image":"nginx:old"}';
const MANIFEST = '{ "image": "nginx:new", "env": {"VALUE": "exact secret bytes"} }\n';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const chain = {} as CosmosClientManager;
const histories = new Map<string, FredLeaseReleases>();

const release = (version: number, status = 'active', reason?: string): FredLeaseRelease => ({
  version, status, image: 'nginx', created_at: '2026-09-22T12:00:00Z',
  ...(reason ? { reason, message: 'Replacement failed; original runtime restored.' } : {}),
});
function history(leaseUuid: string, ...releases: FredLeaseRelease[]): FredLeaseReleases {
  return { lease_uuid: leaseUuid, tenant: ADDRESS, provider_uuid: 'dev', releases };
}

function setup(names = ['example']) {
  const apps: AppEntry[] = names.map((name) => ({
    name, leaseUuid: crypto.randomUUID(), providerUrl: PROVIDER, providerUuid: 'dev',
    size: 'small', createdAt: 0, status: 'running', chainState: 'active',
    provisionState: 'confirmed', manifest: OLD_MANIFEST,
  }));
  for (const app of apps) histories.set(app.leaseUuid, history(app.leaseUuid, release(1)));
  const signArbitrary = vi.fn(async () => ({
    pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'cHVia2V5' }, signature: 'c2lnbmF0dXJl',
  }));
  const providerAuth = createProviderAuth({
    getAddress: async () => asAddress(ADDRESS),
    getSigner: async () => { throw new Error('Maintenance must not request a chain signer'); },
    signArbitrary,
  }, { chainId: 'manifest-dev' });
  const signing = {
    providerAuth,
    authTokens: { getAuthToken: (leaseUuid: string) => providerAuth.providerToken({ address: ADDRESS, leaseUuid }) },
  } as unknown as SigningContext;
  const appRegistry = makeRegistry(apps);
  const options: ToolExecutorOptions = { address: ADDRESS, clientManager: chain, signing, appRegistry, tiers: [] };
  const plans = apps.map((app) => ({
    app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: PROVIDER, idempotencyKey: crypto.randomUUID(),
  }));
  return { apps, plans, options, appRegistry, signArbitrary };
}

function accepted() {
  return new Response(JSON.stringify({ status: 'restarting' }), { status: 202 });
}
function dispatch(operation: 'restart' | 'update', plan: ReturnType<typeof setup>['plans'][number], options: ToolExecutorOptions, manifest = MANIFEST) {
  return operation === 'restart'
    ? executeConfirmedRestartApp(plan, chain, options)
    : executeConfirmedUpdateApp({ ...plan, _generatedManifest: manifest }, chain, options);
}
function requests() {
  return vi.mocked(providerFetch).mock.calls.map(([url, init]) => ({
    url: String(url), key: new Headers(init?.headers).get('Idempotency-Key'),
    auth: new Headers(init?.headers).get('Authorization'), body: init?.body,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  histories.clear();
  // Advance wall time between auth mints without introducing real one-second waits.
  let clock = Date.UTC(2026, 8, 22, 12);
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
  vi.mocked(getReadClient).mockResolvedValue({ query: {} } as Awaited<ReturnType<typeof getReadClient>>);
  vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE, phase: 'ready' } as Awaited<ReturnType<typeof waitForLeaseStatus>>);
  vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'ready', fail_count: 0 });
  vi.mocked(getLeaseReleases).mockImplementation(async (_provider, lease) => histories.get(lease)!);
  vi.mocked(resolveAppUrl).mockResolvedValue({ url: 'https://app.example.com' });
  vi.mocked(providerFetch).mockImplementation(async () => accepted());
});
afterEach(() => vi.restoreAllMocks());

describe.each(['restart', 'update'] as const)('%s command recovery through the real SDK', (operation) => {
  it.each([
    ['lost response', 0, operation === 'restart' ? 'RESTART_INDETERMINATE' : 'UPDATE_INDETERMINATE'],
    ['busy conflict', 409, 'MAINTENANCE_REQUEST_FAILED'],
    ['pending timeout', 503, operation === 'restart' ? 'RESTART_INDETERMINATE' : 'UPDATE_INDETERMINATE'],
    ['persistence failure', 500, operation === 'restart' ? 'RESTART_INDETERMINATE' : 'UPDATE_INDETERMINATE'],
  ])('retains one key and exact payload after %s, minting fresh retry authentication', async (_label, status, code) => {
    const { apps: [app], plans: [plan], options } = setup();
    vi.mocked(providerFetch).mockImplementationOnce(async () => {
      // A lost response can hide completed work; retries still use the original
      // release baseline instead of treating this current generation as old.
      if (status === 0) {
        histories.set(app.leaseUuid, history(app.leaseUuid, release(1, 'superseded'), release(2)));
        throw new TypeError('Response lost after command admission');
      }
      return new Response(JSON.stringify({ error: 'maintenance pending' }), { status });
    });
    const first = await dispatch(operation, plan, options);
    expect(first).toMatchObject({ success: false, error: expect.stringContaining('unconfirmed') });
    expect(first.error).toContain('Do not submit a new command');
    expect(waitForLeaseStatus).not.toHaveBeenCalled();
    const sdkCall = operation === 'restart' ? vi.mocked(restartApp) : vi.mocked(updateApp);
    await expect(sdkCall.mock.results[0].value).rejects.toMatchObject({ code });
    expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)?.idempotencyKey).toBe(plan.idempotencyKey);

    vi.mocked(providerFetch).mockImplementationOnce(async () => {
      histories.set(app.leaseUuid, history(app.leaseUuid, release(1, 'superseded'), release(2)));
      return accepted();
    });
    expect(await dispatch(operation, plan, options)).toMatchObject({ success: true });
    const sent = requests();
    expect(sent).toHaveLength(2);
    expect(sent[0].key).toMatch(UUID_V4);
    expect(sent[1].key).toBe(sent[0].key);
    expect(sent[1].body).toBe(sent[0].body);
    expect(sent[1].auth).not.toBe(sent[0].auth);
    if (operation === 'update') {
      expect(atob(JSON.parse(sent[0].body as string).payload)).toBe(MANIFEST);
    }
    expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)).toBeUndefined();
  });

  it('keeps acknowledged replays unconfirmed while only the old healthy release exists', async () => {
    const { apps: [app], plans: [plan], options } = setup();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await dispatch(operation, plan, options)).toMatchObject({
        success: false, error: expect.stringContaining('No new release'),
      });
    }
    expect(new Set(requests().map((request) => request.key))).toEqual(new Set([plan.idempotencyKey]));
    expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)?.baselineReleaseVersions).toEqual([1]);
    expect(options.appRegistry?.getAppByLease(ADDRESS, app.leaseUuid)?.manifest).toBe(OLD_MANIFEST);
  });

  it.each([404, 409])('settles only the exact durable Fred %i refusal, including a lost-response retry', async (status) => {
    const { apps: [app], plans: [plan], options } = setup();
    vi.mocked(providerFetch).mockRejectedValueOnce(new TypeError('Lost response'));
    expect((await dispatch(operation, plan, options)).error).toContain('unconfirmed');
    const error = status === 404 ? 'lease not yet provisioned' : `invalid state for ${operation}`;
    vi.mocked(providerFetch).mockResolvedValueOnce(new Response(JSON.stringify({ code: status, error }), { status }));
    const result = await dispatch(operation, plan, options);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining(error) });
    expect(result.error).not.toContain('unconfirmed');
    expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)).toBeUndefined();
    expect(options.appRegistry?.getAppByLease(ADDRESS, app.leaseUuid)).toMatchObject({ status: 'running', manifest: OLD_MANIFEST });
    expect(await dispatch(operation, plan, options)).toEqual(result);
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(waitForLeaseStatus).not.toHaveBeenCalled();
  });

  it('retains a 400 refusal because its body cannot distinguish prior command admission', async () => {
    const { apps: [app], plans: [plan], options } = setup();
    vi.mocked(providerFetch).mockResolvedValueOnce(new Response(JSON.stringify({ code: 400, error: 'invalid manifest' }), { status: 400 }));
    expect((await dispatch(operation, plan, options)).error).toContain('unconfirmed');
    expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)?.idempotencyKey).toBe(plan.idempotencyKey);
  });

  it('reports compensated failure while retaining the healthy original runtime', async () => {
    const { apps: [app], plans: [plan], options, appRegistry } = setup();
    const reason = operation === 'restart' ? 'RestartFailed' : 'UpdateFailed';
    vi.mocked(providerFetch).mockImplementationOnce(async () => {
      histories.set(app.leaseUuid, history(app.leaseUuid, release(1), release(2, 'failed', reason)));
      return accepted();
    });
    vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'ready', fail_count: 1, reason } as FredLeaseProvision);
    const result = await dispatch(operation, plan, options);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('previous runtime is healthy') });
    expect(result.error).toContain(reason);
    expect(appRegistry.getAppByLease(ADDRESS, app.leaseUuid)).toMatchObject({ status: 'running', manifest: OLD_MANIFEST });
    expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)).toBeUndefined();
  });

  it('verifies a failed command after the readiness wait rejects and releases its key', async () => {
    const { apps: [app], plans: [plan], options, appRegistry } = setup();
    const reason = operation === 'restart' ? 'RestartFailed' : 'UpdateFailed';
    vi.mocked(providerFetch).mockImplementationOnce(async () => {
      histories.set(app.leaseUuid, history(app.leaseUuid, release(1), release(2, 'failed', reason)));
      return accepted();
    });
    vi.mocked(waitForLeaseStatus).mockRejectedValueOnce(new Error('Runtime provisioning failed'));
    vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'failed', fail_count: 1, reason } as FredLeaseProvision);
    const result = await dispatch(operation, plan, options);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining(reason) });
    expect(result.error).not.toContain('unconfirmed');
    expect(appRegistry.getAppByLease(ADDRESS, app.leaseUuid)).toMatchObject({ status: 'failed', manifest: OLD_MANIFEST });
    expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)).toBeUndefined();
  });
});

it('gives batch items independent keys and retries only the unresolved command', async () => {
  const { apps, plans, options } = setup(['first', 'second']);
  vi.mocked(providerFetch).mockImplementation(async (input) => {
    const app = apps.find((entry) => String(input).includes(entry.leaseUuid))!;
    if (app.name === 'second') throw new TypeError('Response lost');
    histories.set(app.leaseUuid, history(app.leaseUuid, release(1, 'superseded'), release(2)));
    return accepted();
  });
  const args = { app_name: 'all', entries: plans };
  await executeConfirmedRestartApp(args, chain, options);
  expect(new Set(requests().map((request) => request.key)).size).toBe(2);
  expect(requests().every((request) => UUID_V4.test(request.key!))).toBe(true);
  const recovery = await executeRestartApp({ app_name: 'all' }, options);
  expect(recovery.pendingAction?.args.entries).toEqual([plans[1]]);

  vi.mocked(providerFetch).mockImplementation(async (input) => {
    expect(String(input)).toContain(apps[1].leaseUuid);
    histories.set(apps[1].leaseUuid, history(apps[1].leaseUuid, release(1, 'superseded'), release(2)));
    return accepted();
  });
  // Replaying the original approved batch also must not resubmit the success.
  const onProgress = vi.fn();
  await executeConfirmedRestartApp(args, chain, { ...options, onProgress });
  expect(requests()).toHaveLength(3);
  expect(requests().at(-1)?.key).toBe(plans[1].idempotencyKey);
  expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'ready', batch: [
    expect.objectContaining({ name: 'first', phase: 'ready' }),
    expect.objectContaining({ name: 'second', phase: 'ready' }),
  ] }));
});

it('refuses changed update bytes while the previous command outcome remains unknown', async () => {
  const { plans: [plan], options } = setup();
  vi.mocked(providerFetch).mockRejectedValueOnce(new TypeError('Response lost'));
  await dispatch('update', plan, options);
  const changed = await dispatch('update', plan, options, JSON.stringify(JSON.parse(MANIFEST)));
  expect(changed).toMatchObject({ success: false, error: expect.stringContaining('different manifest bytes') });
  expect(providerFetch).toHaveBeenCalledTimes(1);
});

it('fresh update tool invocations recover the saved key and original bytes without merging again', async () => {
  const { apps: [app], plans: [plan], options, appRegistry } = setup();
  vi.mocked(providerFetch).mockRejectedValueOnce(new TypeError('Response lost'));
  await dispatch('update', plan, options);
  // Registry observations may change while an uncertain update is retained.
  appRegistry.updateApp(ADDRESS, app.leaseUuid, { manifest: '{"image":"different-observation","env":{"UNRELATED":"value"}}' });
  const firstRetry = await executeUpdateApp({ app_name: app.name }, options);
  const secondRetry = await executeUpdateApp({ app_name: app.name }, options);
  const expected = { ...plan, _generatedManifest: MANIFEST, _maintenanceRetry: true };
  expect(firstRetry.pendingAction?.args).toEqual(expected);
  expect(secondRetry.pendingAction?.args).toEqual(expected);
  expect(providerFetch).toHaveBeenCalledTimes(1);
});

it('rejects invalid edited manifests before saving a new operation or requesting authentication', async () => {
  const { apps: [app], plans: [plan], options, signArbitrary } = setup();
  const result = await dispatch('update', plan, options, '{"image":"nginx","labels":{"com.docker.compose.project":"forbidden"}}');
  expect(result).toMatchObject({ success: false, error: expect.stringContaining('reserved prefix') });
  expect(providerFetch).not.toHaveBeenCalled();
  expect(signArbitrary).not.toHaveBeenCalled();
  expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)).toBeUndefined();
});

it('retains the command if post-readiness verification is unavailable', async () => {
  const { apps: [app], plans: [plan], options } = setup();
  vi.mocked(getLeaseProvision).mockRejectedValueOnce(new TypeError('Read unavailable'));
  const result = await dispatch('restart', plan, options);
  expect(result).toMatchObject({ success: false, error: expect.stringContaining('unconfirmed') });
  expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)?.idempotencyKey).toBe(plan.idempotencyKey);
});

it('does not dispatch without an unambiguous original release baseline', async () => {
  const { apps: [app], plans: [plan], options } = setup();
  histories.set(app.leaseUuid, history(app.leaseUuid, release(1), release(2, 'deploying')));
  expect(await dispatch('restart', plan, options)).toMatchObject({
    success: false, error: expect.stringContaining('release v2 is deploying'),
  });
  expect(providerFetch).not.toHaveBeenCalled();
});

describe('pre-dispatch cancellation and local failures', () => {
  it.each(['baseline', 'authentication', 'context', 'authorization'] as const)('discards a new command after a local %s failure', async (stage) => {
    const { apps: [app], plans: [plan], options, signArbitrary } = setup();
    const controller = new AbortController();
    options.signal = controller.signal;
    if (stage === 'baseline') {
      vi.mocked(getLeaseReleases).mockImplementationOnce(async () => {
        controller.abort();
        return histories.get(app.leaseUuid)!;
      });
    } else if (stage === 'authentication') {
      signArbitrary.mockImplementationOnce(async () => ({ pub_key: { type: 'key', value: 'cHVia2V5' }, signature: 'c2ln' }));
      signArbitrary.mockImplementationOnce(async () => {
        controller.abort();
        return { pub_key: { type: 'key', value: 'cHVia2V5' }, signature: 'c2ln' };
      });
    } else if (stage === 'context') {
      vi.mocked(getReadClient).mockRejectedValueOnce(new Error('Read client unavailable'));
    } else {
      options.assertAuthorization = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('Wallet changed'); });
    }
    const result = await dispatch('restart', plan, options);
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('unconfirmed');
    if (controller.signal.aborted) expect(result.error).toContain('cancelled before dispatch');
    expect(providerFetch).not.toHaveBeenCalled();
    expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)).toBeUndefined();
  });

  it('puts a batch abort during authentication in Cancelled, without a retained command', async () => {
    const { apps: [app], plans, options, signArbitrary } = setup();
    const controller = new AbortController();
    options.signal = controller.signal;
    signArbitrary.mockImplementationOnce(async () => ({ pub_key: { type: 'key', value: 'cHVia2V5' }, signature: 'c2ln' }));
    signArbitrary.mockImplementationOnce(async () => {
      controller.abort();
      return { pub_key: { type: 'key', value: 'cHVia2V5' }, signature: 'c2ln' };
    });
    const result = await executeConfirmedRestartApp({ app_name: 'all', entries: plans }, chain, options);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Cancelled: example') });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)).toBeUndefined();
  });

  it('preserves an existing command when its retry is cancelled locally', async () => {
    const { apps: [app], plans: [plan], options } = setup();
    vi.mocked(providerFetch).mockRejectedValueOnce(new TypeError('Lost response'));
    await dispatch('restart', plan, options);
    const controller = new AbortController();
    controller.abort();
    const result = await dispatch('restart', plan, { ...options, signal: controller.signal });
    expect(result.error).toContain('unconfirmed');
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)?.idempotencyKey).toBe(plan.idempotencyKey);
  });
});

it('stops verification immediately when the readiness wait is cancelled', async () => {
  const { apps: [app], plans: [plan], options, signArbitrary } = setup();
  const controller = new AbortController();
  vi.mocked(waitForLeaseStatus).mockImplementationOnce(async () => {
    controller.abort();
    throw new DOMException('Cancelled', 'AbortError');
  });
  const result = await dispatch('restart', plan, { ...options, signal: controller.signal });
  expect(result.error).toContain('unconfirmed');
  expect(signArbitrary).toHaveBeenCalledTimes(2); // Original baseline and POST only.
  expect(getLeaseReleases).toHaveBeenCalledTimes(1);
  expect(getLeaseProvision).not.toHaveBeenCalled();
  expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)).toMatchObject({ idempotencyKey: plan.idempotencyKey, accepted: true });
});

it('compares completed payload fingerprints while avoiding another POST', async () => {
  const { apps: [app], plans: [plan], options } = setup();
  vi.mocked(providerFetch).mockImplementationOnce(async () => {
    histories.set(app.leaseUuid, history(app.leaseUuid, release(1, 'superseded'), release(2)));
    return accepted();
  });
  expect((await dispatch('update', plan, options)).success).toBe(true);
  expect((await dispatch('update', plan, options)).success).toBe(true);
  expect((await dispatch('update', plan, options, MANIFEST.trim())).error).toContain('different payload bytes');
  expect(providerFetch).toHaveBeenCalledTimes(1);
});

it.each(['restart', 'update'] as const)('does not repeat a confirmed %s after read-only reconciliation settles it', async (operation) => {
  const { apps: [app], plans: [plan], options } = setup();
  expect((await dispatch(operation, plan, options)).error).toContain('unconfirmed');
  histories.set(app.leaseUuid, history(app.leaseUuid, release(1, 'superseded'), release(2)));
  expect(await reconcilePendingMaintenance(app, options)).toMatchObject({ outcome: 'succeeded' });
  expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)).toBeUndefined();
  expect((await dispatch(operation, plan, options)).success).toBe(true);
  expect(providerFetch).toHaveBeenCalledTimes(1);
});

it('does not overwrite a newer command after an older endpoint lookup finishes', async () => {
  const { apps: [app], plans: [plan], options, appRegistry } = setup();
  vi.mocked(providerFetch).mockImplementationOnce(async () => {
    histories.set(app.leaseUuid, history(app.leaseUuid, release(1, 'superseded'), release(2)));
    return accepted();
  });
  let nextKey: string | undefined;
  vi.mocked(resolveAppUrl).mockImplementationOnce(async () => {
    const prior = getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)!;
    await completeMaintenanceOperation(prior);
    const next = await getOrCreateMaintenanceOperation({
      address: ADDRESS, providerUrl: PROVIDER, leaseUuid: app.leaseUuid,
      operation: 'update', manifest: '{"image":"nginx:next"}', baselineReleaseVersions: [1, 2],
    });
    nextKey = next.idempotencyKey;
    appRegistry.updateApp(ADDRESS, app.leaseUuid, { manifest: '{"image":"nginx:next"}', url: 'https://next.example' });
    return { url: 'https://stale.example' };
  });
  expect((await dispatch('update', plan, options)).error).toContain('unconfirmed');
  expect(appRegistry.getAppByLease(ADDRESS, app.leaseUuid)).toMatchObject({ manifest: '{"image":"nginx:next"}', url: 'https://next.example' });
  expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)?.idempotencyKey).toBe(nextKey);
});

it('does not write a settled observation after cancellation during endpoint lookup', async () => {
  const { apps: [app], plans: [plan], options, appRegistry } = setup();
  const controller = new AbortController();
  vi.mocked(providerFetch).mockImplementationOnce(async () => {
    histories.set(app.leaseUuid, history(app.leaseUuid, release(1, 'superseded'), release(2)));
    return accepted();
  });
  vi.mocked(resolveAppUrl).mockImplementationOnce(async () => {
    controller.abort();
    return { url: 'https://stale.example' };
  });
  expect((await dispatch('update', plan, { ...options, signal: controller.signal })).error).toContain('unconfirmed');
  expect(appRegistry.getAppByLease(ADDRESS, app.leaseUuid)?.manifest).toBe(OLD_MANIFEST);
  expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)?.idempotencyKey).toBe(plan.idempotencyKey);
});

it('preserves the registry manifest after a reload and compensated update failure', async () => {
  const { apps: [app], plans: [plan], options, appRegistry } = setup();
  await dispatch('update', plan, options); // accepted, but the old release remains visible
  vi.resetModules();
  const { executeMaintenance } = await import('./maintenanceExecution');
  const freshOperations = await import('./maintenanceOperation');
  expect(freshOperations.getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)?.previousManifest).toBeUndefined();
  vi.mocked(providerFetch).mockImplementationOnce(async () => {
    histories.set(app.leaseUuid, history(app.leaseUuid, release(1), release(2, 'failed', 'UpdateFailed')));
    return accepted();
  });
  const { result } = await executeMaintenance({ ...plan, operation: 'update', manifest: MANIFEST }, options);
  expect(result.error).toContain('Update failed');
  expect(appRegistry.getAppByLease(ADDRESS, app.leaseUuid)?.manifest).toBe(OLD_MANIFEST);
  expect(freshOperations.getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)).toBeUndefined();
});

it('cancels a new command while its dispatch Web Lock is queued without sending or retaining it', async () => {
  const { apps: [app], plans: [plan], options } = setup();
  const controller = new AbortController();
  let notifyQueued!: () => void;
  const queued = new Promise<void>((resolve) => { notifyQueued = resolve; });
  let releaseLock!: () => void;
  const heldLock = new Promise<void>((resolve) => { releaseLock = resolve; });
  let lockRequests = 0;
  vi.stubGlobal('navigator', {
    locks: { request: vi.fn(async (_name: string, action: () => unknown) => {
      lockRequests += 1;
      // Preparation takes the first lock. Delay only the subsequent handoff
      // so cancellation happens after SDK authentication and its own guard.
      if (lockRequests === 2) {
        notifyQueued();
        await heldLock;
      }
      return action();
    }) },
  });
  try {
    const execution = dispatch('restart', plan, { ...options, signal: controller.signal });
    await queued;
    controller.abort();
    releaseLock();
    expect(await execution).toMatchObject({ success: false, error: expect.stringContaining('cancelled before dispatch') });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)).toBeUndefined();
  } finally {
    releaseLock();
    vi.unstubAllGlobals();
  }
});
