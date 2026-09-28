import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { asAddress, type CosmosClientManager } from '@manifest-network/manifest-sdk';
import { createProviderAuth, LeaseState, waitForLeaseStatus, type FredLeaseReleases } from '@manifest-network/manifest-sdk/deploy';
import { getLeaseProvision, getLeaseReleases } from '../../api/fred';
import { getReadClient } from '../../api/readClient';
import { providerFetch } from '../../api/providerFetchAdapter';
import { compactMessagesForRelay, serializeMessagesForApi, type ChatApiMessage } from '../../api/morpheus';
import { MessageBubble } from '../../components/ai/MessageBubble';
import { runtimeConfig } from '../../config/runtimeConfig';
import type { ChatMessage } from '../../contexts/aiTypes';
import type { AppEntry } from '../../registry/appRegistry';
import { loadHistory, saveHistory } from '../../stores/aiActions/persistence';
import { toChatApiMessages } from '../../stores/aiActions/utils';
import { createWalletIdentity } from '../../utils/walletIdentity';
import { executeConfirmedTool } from './index';
import { clearCompletedMaintenance } from './maintenanceCompletion';
import { getPendingMaintenanceOperation } from './maintenanceOperation';
import { reconcilePendingMaintenance } from './maintenanceReconciliation';
import { resolveAppUrl } from './deployUrl';
import { makeRegistry } from './testHelpers';
import type { SigningContext, ToolExecutorOptions, ToolResult } from './types';

// Keep SDK mutation/authentication and the public collector real. Control only
// provider I/O, readiness observations, and the UI's outgoing user message.
vi.mock('@manifest-network/manifest-sdk/deploy', async original => ({
  ...await original<typeof import('@manifest-network/manifest-sdk/deploy')>(), waitForLeaseStatus: vi.fn(),
}));
vi.mock('../../api/readClient', () => ({ getReadClient: vi.fn() }));
vi.mock('../../api/providerFetchAdapter', () => ({ providerFetch: vi.fn() }));
vi.mock('../../api/fred', async original => ({
  ...await original<typeof import('../../api/fred')>(), getLeaseProvision: vi.fn(), getLeaseReleases: vi.fn(),
}));
vi.mock('./deployUrl', async original => ({
  ...await original<typeof import('./deployUrl')>(), resolveAppUrl: vi.fn(),
}));
vi.mock('../../contexts/aiStoreContext', () => ({
  useAIStore: (selector: (state: unknown) => unknown) => selector({ sendMessage, retrySkuTiers: vi.fn() }),
}));

const sendMessage = vi.fn();
const ADDRESS = 'manifest1recoveryboundary';
const PROVIDER = 'https://s049-u002.manifest0.net/api/fred';
const MANIFEST = '{ "image": "nginx:new", "env": { "PASSWORD": "boundary-secret" } }\n';
const PROHIBITION = 'Do not submit a new command or automatically stop/redeploy to recover this outcome.';
const OBSERVE = 'Check app_status and app_releases for the affected apps before any further maintenance.';
const identity = createWalletIdentity(runtimeConfig.PUBLIC_CHAIN_ID, ADDRESS)!;
const chain = {} as CosmosClientManager;
const histories = new Map<string, FredLeaseReleases>();
let root: Root;
let container: HTMLDivElement;

function fixture(names = ['web']) {
  const apps: AppEntry[] = names.map(name => ({ name, leaseUuid: crypto.randomUUID(), providerUrl: PROVIDER,
    providerUuid: 'dev', size: 'small', createdAt: 1, status: 'running', chainState: 'active',
    provisionState: 'confirmed', manifest: '{"image":"nginx:old"}' }));
  for (const app of apps) histories.set(app.leaseUuid, { lease_uuid: app.leaseUuid, tenant: ADDRESS, provider_uuid: 'dev',
    releases: [{ version: 1, status: 'active', image: 'nginx:old', created_at: '2026-09-22T12:00:00Z' }] });
  const providerAuth = createProviderAuth({
    getAddress: async () => asAddress(ADDRESS),
    getSigner: async () => { throw new Error('Maintenance must not request a chain signer'); },
    signArbitrary: async () => ({ pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'cHVia2V5' }, signature: 'c2lnbmF0dXJl' }),
  }, { chainId: runtimeConfig.PUBLIC_CHAIN_ID });
  const appRegistry = makeRegistry(apps);
  const options: ToolExecutorOptions = { address: ADDRESS, clientManager: chain, appRegistry, tiers: [],
    signing: { providerAuth, authTokens: {
      getAuthToken: (leaseUuid: string) => providerAuth.providerToken({ address: ADDRESS, leaseUuid }),
    } } as unknown as SigningContext,
    authorization: { originAddress: ADDRESS, chainId: runtimeConfig.PUBLIC_CHAIN_ID, clientGeneration: 1, signerGeneration: 1 },
    assertAuthorization: vi.fn(), onProgress: vi.fn(),
  };
  const plans = apps.map(app => ({ app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: PROVIDER, idempotencyKey: crypto.randomUUID() }));
  return { apps, plans, options, appRegistry };
}

function persistAndProject(result: ToolResult, toolName: 'restart_app' | 'update_app') {
  // Same result serialization and source-row fields as confirmAction. Advice
  // lives beside the content and must never enter model-facing JSON.
  const source: ChatMessage = { id: 'maintenance-result', role: 'tool', toolName, toolCallId: 'maintenance-call', timestamp: Date.now(),
    content: JSON.stringify({ success: result.success, data: result.data, error: result.error }, null, 2),
    error: result.success ? undefined : result.error, maintenanceRecoveryAdvice: result.maintenanceRecoveryAdvice };
  const messages: ChatMessage[] = [
    { id: 'request', role: 'user', content: 'Perform the requested maintenance.', timestamp: 1 },
    { id: 'call', role: 'assistant', content: 'Calling tools.', timestamp: 2,
      toolCalls: [{ id: 'maintenance-call', type: 'function', function: { name: toolName, arguments: { app_name: 'web' } } }] },
    source,
  ];
  saveHistory(identity, messages, true);
  const restored = loadHistory(identity);
  const reloaded = restored.find(message => message.id === source.id)!;
  expect(reloaded.content).toBe(source.content);
  expect(reloaded.error).toBe(source.error);
  expect(reloaded.maintenanceRecoveryAdvice).toEqual(source.maintenanceRecoveryAdvice);
  // This is the next read-only request sent by the recovery suggestion. The
  // saved assistant call was stripped, so the old result must be context, not
  // an orphan protocol reply that a strict backend would reject.
  const next = [...restored, { id: 'observe', role: 'user' as const, content: OBSERVE, timestamp: Date.now() }];
  const model = serializeMessagesForApi(compactMessagesForRelay(toChatApiMessages(next, ADDRESS))) as ChatApiMessage[];
  const modelResult = model.find(message => message.content === `Historical tool result:\n${source.content}`)!;
  expect(modelResult).toEqual({ role: 'assistant', content: `Historical tool result:\n${source.content}` });
  expect(model.some(message => message.role === 'tool' || message.tool_calls || message.tool_call_id)).toBe(false);
  expect(modelResult.content).toContain(PROHIBITION);
  expect(JSON.stringify(model)).not.toContain('maintenanceRecoveryAdvice');
  expect(JSON.stringify(model)).not.toContain('boundary-secret');
  for (const advice of source.maintenanceRecoveryAdvice ?? []) expect(JSON.stringify(model)).not.toContain(advice.idempotencyKey);
  return { source, reloaded, modelResult, resultPayload: modelResult.content!.slice('Historical tool result:\n'.length) };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  histories.clear();
  clearCompletedMaintenance(identity);
  // Fresh SDK tokens require advancing timestamps. Avoid real one-second
  // authentication waits while retaining the SDK's actual signing behavior.
  let clock = Date.UTC(2026, 8, 22, 12);
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
  vi.mocked(getReadClient).mockResolvedValue({ query: {} } as Awaited<ReturnType<typeof getReadClient>>);
  vi.mocked(getLeaseReleases).mockImplementation(async (_provider, lease) => histories.get(lease)!);
  vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'ready', fail_count: 0 });
  vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE, phase: 'ready' } as Awaited<ReturnType<typeof waitForLeaseStatus>>);
  vi.mocked(resolveAppUrl).mockResolvedValue({ url: 'https://app.example.com' });
  vi.mocked(providerFetch).mockRejectedValue(new TypeError('Response lost after provider admission'));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe('maintenance recovery across execution, persistence, model and UI', () => {
  it.each(['restart', 'update'] as const)('keeps a real lost-response %s observation-only after history reload', async operation => {
    const { apps: [app], plans: [plan], options, appRegistry } = fixture();
    const toolName = `${operation}_app` as const;
    const result = await executeConfirmedTool(toolName, { ...plan, ...(operation === 'update' && { _generatedManifest: MANIFEST }) }, options);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('is unconfirmed') });
    expect(result.maintenanceRecoveryAdvice).toEqual([expect.objectContaining({ operation, idempotencyKey: plan.idempotencyKey, chainId: identity.chainId })]);
    expect(await reconcilePendingMaintenance(app, options, undefined, 'ready')).toMatchObject({ outcome: 'unconfirmed', runtimeReady: true });
    expect(appRegistry.getAppByLease(ADDRESS, app.leaseUuid)).toMatchObject({ status: 'running', provisionState: 'confirmed' });
    const pending = getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)!;
    expect(pending).toMatchObject({ idempotencyKey: plan.idempotencyKey, baselineReleaseVersions: [1] });
    expect(pending.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Headers(vi.mocked(providerFetch).mock.calls[0][1]?.headers).get('Idempotency-Key')).toBe(pending.idempotencyKey);
    if (operation === 'update') {
      expect(pending.manifest).toBe(MANIFEST);
      expect(atob(JSON.parse(vi.mocked(providerFetch).mock.calls[0][1]?.body as string).payload)).toBe(MANIFEST);
    }
    const { source, reloaded } = persistAndProject(result, toolName);
    for (const message of [source, reloaded]) {
      sendMessage.mockClear();
      flushSync(() => root.render(createElement(MessageBubble, { message })));
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(PROHIBITION);
      const buttons = [...container.querySelectorAll('button')];
      expect(buttons.some(button => button.textContent === 'Deploy an app')).toBe(false);
      const checkStatus = buttons.find(button => button.textContent === 'Check status');
      expect(checkStatus).toBeDefined();
      flushSync(() => checkStatus!.click());
      expect(sendMessage).toHaveBeenCalledExactlyOnceWith(OBSERVE);
    }
    expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, app.leaseUuid)?.idempotencyKey).toBe(plan.idempotencyKey);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(waitForLeaseStatus).not.toHaveBeenCalled();
  });

  it('preserves the unknown row and recovery prohibition alongside a real successful batch item', async () => {
    const { apps, plans, options } = fixture(['web', 'settled']);
    vi.mocked(providerFetch).mockImplementation(async input => {
      const app = apps.find(value => String(input).includes(value.leaseUuid))!;
      if (app.name === 'web') throw new TypeError('Response lost after provider admission');
      histories.set(app.leaseUuid, { ...histories.get(app.leaseUuid)!, releases: [
        { version: 1, status: 'superseded', image: 'nginx:old', created_at: '2026-09-22T12:00:00Z' },
        { version: 2, status: 'active', image: 'nginx:old', created_at: '2026-09-22T12:01:00Z' },
      ] });
      return Response.json({ status: 'restarting' }, { status: 202 });
    });
    const result = await executeConfirmedTool('restart_app', { app_name: 'all', entries: plans }, options);
    expect(result).toMatchObject({ success: true, data: {
      restarted: [expect.objectContaining({ name: 'settled' })],
      unconfirmed: [expect.objectContaining({ name: 'web', outcome: 'unconfirmed' })],
      message: expect.stringContaining('Outcome unknown'),
    } });
    expect(options.onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'unconfirmed' }));
    expect(result.maintenanceRecoveryAdvice).toEqual([expect.objectContaining({ leaseUuid: apps[0].leaseUuid, idempotencyKey: plans[0].idempotencyKey })]);
    const { reloaded, modelResult, resultPayload } = persistAndProject(result, 'restart_app');
    expect(JSON.parse(resultPayload)).toMatchObject({ success: true, data: {
      restarted: [expect.objectContaining({ name: 'settled' })], unconfirmed: [expect.objectContaining({ name: 'web' })],
    } });
    expect(modelResult.content).not.toContain('All 2');
    flushSync(() => root.render(createElement(MessageBubble, { message: reloaded })));
    // Successful envelopes keep the structured mixed result in the disclosure;
    // they do not gain a fabricated error or a mutation suggestion on reload.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Deploy an app')).toBe(false);
    expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, apps[0].leaseUuid)?.idempotencyKey).toBe(plans[0].idempotencyKey);
    expect(getPendingMaintenanceOperation(ADDRESS, PROVIDER, apps[1].leaseUuid)).toBeUndefined();
    expect(new Set(vi.mocked(providerFetch).mock.calls.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key')))).toEqual(new Set(plans.map(plan => plan.idempotencyKey)));
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });
});
