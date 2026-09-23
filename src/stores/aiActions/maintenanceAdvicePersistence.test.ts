import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { runtimeConfig } from '../../config/runtimeConfig';
import type { ChatMessage } from '../../contexts/aiTypes';
import type { AIStore } from '../aiStore';
import { makeRegistry } from '../../ai/toolExecutor/testHelpers';

vi.mock('../../config/fredCompatibility', () => ({ fredCompatibilityForProvider: () => 'pr240' }));

const identity = { address: 'manifest1transcript', chainId: runtimeConfig.PUBLIC_CHAIN_ID };
const providerUrl = 'https://provider.example';
const app = { name: 'web', leaseUuid: '550e8400-e29b-41d4-a716-446655440000', providerUrl,
  providerUuid: 'provider', createdAt: 0, status: 'running' as const, chainState: 'active' as const,
  provisionState: 'confirmed' as const, size: 'small' };
const scope = { ...identity, providerUrl, leaseUuid: app.leaseUuid };
const row = (id: string, content: string): ChatMessage => ({ id, role: 'tool', toolName: 'restart_app', content, timestamp: 1 });
const options = () => ({ address: identity.address, clientManager: null, appRegistry: makeRegistry([app]), tiers: [] });

function session(quota = false): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null, removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { if (quota) throw new DOMException('Quota', 'QuotaExceededError'); values.set(key, value); } };
}
async function tab(quota = false) {
  vi.stubGlobal('sessionStorage', session(quota));
  vi.resetModules();
  return {
    state: await import('../../ai/toolExecutor/maintenanceOperation'),
    intent: await import('../../ai/toolExecutor/maintenanceRecoveryIntent'),
    history: await import('./persistence'),
    tools: await import('../../ai/toolExecutor/compositeTransactions'),
  };
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('maintenance advice attached to saved conversation rows', () => {
  it.each([false, true])('preserves older sent-command advice when a newer never-sent row is restored (proof read fails=%s)', async (proofReadFails) => {
    const a = await tab();
    const first = await a.state.getOrCreateMaintenanceOperation({ ...scope, operation: 'restart', baselineReleaseVersions: [1] });
    await a.state.markMaintenanceOperationDispatched(first);
    await a.state.markMaintenanceRecoveryAdvised(first);
    a.history.saveHistory(identity, [row('k1-advice', 'Recover the saved first restart.')], true);
    await a.state.completeMaintenanceOperation(first, undefined, 'succeeded');

    const b = await tab();
    const messages = b.history.loadHistory(identity);
    const second = await b.state.getOrCreateMaintenanceOperation({ ...scope, operation: 'restart', baselineReleaseVersions: [1, 2],
      previousOperationKey: first.idempotencyKey, recoveryIntentKey: first.idempotencyKey });
    await b.state.markMaintenanceOperationDispatched(second);
    b.intent.consumeMaintenanceRecoveryIntent(scope, first.idempotencyKey);
    await b.state.completeMaintenanceOperation(second, undefined, 'succeeded');
    const third = await b.state.getOrCreateMaintenanceOperation({ ...scope, operation: 'restart', baselineReleaseVersions: [1, 2, 3],
      previousOperationKey: second.idempotencyKey });
    await b.state.markMaintenanceRecoveryAdvised(third);
    b.history.saveHistory(identity, [...messages, row('k3-advice', 'Recover the saved third restart.')], true);
    expect(await b.state.discardUnsubmittedMaintenanceOperation(third)).toBe(true);
    expect(b.state.getSettledMaintenanceOperation(scope.address, providerUrl, app.leaseUuid)).toMatchObject({ outcome: 'not_sent', recoveryAdvised: false });

    const c = await tab();
    const storage = localStorage;
    if (proofReadFails) vi.stubGlobal('localStorage', {
      getItem: (key: string) => { if (key.startsWith('barney:maintenance:v1:')) throw new Error('Metadata temporarily unavailable'); return storage.getItem(key); },
      setItem: storage.setItem.bind(storage), removeItem: storage.removeItem.bind(storage),
    });
    c.history.loadHistory(identity);
    vi.stubGlobal('localStorage', storage);
    const replay = await c.tools.executeRestartApp({ app_name: app.name }, options());
    expect(replay.requiresConfirmation).toBeUndefined();
    expect(replay.error).toContain('already settled');
    expect(c.intent.getMaintenanceRecoveryIntent(scope)?.idempotencyKey).toBe(first.idempotencyKey);
    expect((await c.tools.executeRestartApp({ app_name: app.name, new_command: true }, options())).pendingAction?.args).toMatchObject({
      previousOperationKey: third.idempotencyKey, recoveryIntentKey: first.idempotencyKey,
    });
  });

  it('keeps a live tab’s older guard when another tab’s advised but unsent successor is discarded', async () => {
    const a = await tab();
    const first = await a.state.getOrCreateMaintenanceOperation({ ...scope, operation: 'restart', baselineReleaseVersions: [1] });
    await a.state.markMaintenanceOperationDispatched(first);
    await a.state.markMaintenanceRecoveryAdvised(first);
    a.history.saveHistory(identity, [row('k1-advice', 'Recover the saved first restart.')], true);
    await a.state.completeMaintenanceOperation(first, undefined, 'succeeded');
    const b = await tab();
    const second = await b.state.getOrCreateMaintenanceOperation({ ...scope, operation: 'restart', baselineReleaseVersions: [1, 2],
      previousOperationKey: first.idempotencyKey });
    await b.state.markMaintenanceOperationDispatched(second);
    await b.state.completeMaintenanceOperation(second, undefined, 'succeeded');
    const third = await b.state.getOrCreateMaintenanceOperation({ ...scope, operation: 'restart', baselineReleaseVersions: [1, 2, 3],
      previousOperationKey: second.idempotencyKey });
    await a.state.markMaintenanceRecoveryAdvised(third);
    expect(a.intent.getMaintenanceRecoveryIntent(scope)?.idempotencyKey).toBe(first.idempotencyKey);
    await b.state.discardUnsubmittedMaintenanceOperation(third);
    expect((await a.tools.executeRestartApp({ app_name: app.name }, options())).requiresConfirmation).toBeUndefined();
    const deliberate = await a.tools.executeRestartApp({ app_name: app.name, new_command: true }, options());
    expect(deliberate.pendingAction?.args).toMatchObject({ previousOperationKey: third.idempotencyKey, recoveryIntentKey: first.idempotencyKey });
    a.intent.consumeMaintenanceRecoveryIntent(scope, third.idempotencyKey);
    expect(a.intent.getMaintenanceRecoveryIntent(scope)?.idempotencyKey).toBe(first.idempotencyKey);
    a.intent.consumeMaintenanceRecoveryIntent(scope, first.idempotencyKey);
    expect((await a.tools.executeRestartApp({ app_name: app.name }, options())).requiresConfirmation).toBe(true);
  });

  it.each([false, true])('keeps A’s advice through B’s successful successor and a new tab C (session quota=%s)', async (quota) => {
    const a = await tab(quota);
    const first = await a.state.getOrCreateMaintenanceOperation({ ...scope, operation: 'restart', baselineReleaseVersions: [1] });
    await a.state.markMaintenanceOperationDispatched(first);
    await a.state.markMaintenanceRecoveryAdvised(first);
    a.history.saveHistory(identity, [row('k1-advice', 'Retry restart_app(app_name="web") to recover the saved command.')], true);

    const b = await tab();
    const messages = b.history.loadHistory(identity);
    expect(messages[0].maintenanceRecoveryAdvice?.[0].idempotencyKey).toBe(first.idempotencyKey);
    await b.state.completeMaintenanceOperation(first, undefined, 'succeeded');
    const plan = await b.tools.executeRestartApp({ app_name: app.name, new_command: true }, options());
    const second = await b.state.getOrCreateMaintenanceOperation({ ...scope, operation: 'restart', baselineReleaseVersions: [1, 2],
      idempotencyKey: plan.pendingAction!.args.idempotencyKey as string, previousOperationKey: first.idempotencyKey,
      recoveryIntentKey: first.idempotencyKey });
    await b.state.markMaintenanceOperationDispatched(second);
    b.intent.consumeMaintenanceRecoveryIntent(scope, first.idempotencyKey);
    await b.state.completeMaintenanceOperation(second, undefined, 'succeeded');
    expect(b.intent.getMaintenanceRecoveryIntent(scope)).toBeUndefined();
    expect((await b.tools.executeRestartApp({ app_name: app.name }, options())).requiresConfirmation).toBe(true);
    b.history.saveHistory(identity, [...messages, row('k2-success', 'App web has been restarted.')], true);

    const c = await tab();
    c.history.loadHistory(identity);
    const repeatedAdvice = await c.tools.executeRestartApp({ app_name: app.name }, options());
    expect(repeatedAdvice.requiresConfirmation).toBeUndefined();
    expect(repeatedAdvice.error).toContain('already settled');
    expect((await c.tools.executeRestartApp({ app_name: app.name, new_command: true }, options())).pendingAction?.args).toMatchObject({
      previousOperationKey: second.idempotencyKey, recoveryIntentKey: first.idempotencyKey,
    });
    const saved = localStorage.getItem(c.history.historyStorageKey(identity))!;
    expect(saved).not.toMatch(/payloadHash|baselineReleaseVersions|manifest"/);

    // Source rows leave with ordinary history trimming; no global sticky guard
    // is restored from a transcript that no longer contains their advice.
    // Clear active intent as a deliberate successor would before saving the
    // newer messages left after ordinary trimming.
    c.intent.consumeMaintenanceRecoveryIntent(scope, first.idempotencyKey);
    c.history.saveHistory(identity, [row('new-history', 'Fresh conversation.')], true);
    const d = await tab();
    d.history.loadHistory(identity);
    expect((await d.tools.executeRestartApp({ app_name: app.name }, options())).requiresConfirmation).toBe(true);
  });

  it('captures advice in live rows while history is disabled and keeps it after local consumption', async () => {
    const current = await tab(true);
    const command = await current.state.getOrCreateMaintenanceOperation({ ...scope, operation: 'restart', baselineReleaseVersions: [1] });
    await current.state.markMaintenanceRecoveryAdvised(command);
    const store = createStore<AIStore>(() => ({ messages: [], settings: { saveHistory: false }, historyIdentity: identity,
      isStreaming: false, _historyCache: new Map() } as unknown as AIStore));
    const unsubscribe = current.history.setupPersistenceSubscriptions(store);
    try {
      store.setState({ messages: [row('advice', 'Recover the saved restart.')] });
      expect(store.getState().messages[0].maintenanceRecoveryAdvice?.[0].idempotencyKey).toBe(command.idempotencyKey);
      current.intent.consumeMaintenanceRecoveryIntent(scope, command.idempotencyKey);
      store.setState({ settings: { saveHistory: true } });
      const restored = await tab();
      restored.history.loadHistory(identity);
      expect(restored.intent.getMaintenanceRecoveryIntent(scope)?.idempotencyKey).toBe(command.idempotencyKey);
    } finally { unsubscribe(); }
  });

  it('uses never-sent proof to release restored advice after a pre-HTTP cancellation', async () => {
    const a = await tab();
    const command = await a.state.getOrCreateMaintenanceOperation({ ...scope, operation: 'restart', baselineReleaseVersions: [1] });
    await a.state.markMaintenanceRecoveryAdvised(command);
    a.history.saveHistory(identity, [row('advice', 'Recover the saved restart.')], true);
    expect(await a.state.discardUnsubmittedMaintenanceOperation(command)).toBe(true);
    const b = await tab();
    b.history.loadHistory(identity);
    expect((await b.tools.executeRestartApp({ app_name: app.name }, options())).pendingAction?.args).toMatchObject({
      previousOperationKey: command.idempotencyKey,
    });
    expect(b.intent.getMaintenanceRecoveryIntent(scope)).toBeUndefined();
  });

  it('does not let an older network’s advice suppress the active network’s guard', async () => {
    const a = await tab();
    const command = await a.state.getOrCreateMaintenanceOperation({ ...scope, operation: 'restart', baselineReleaseVersions: [1] });
    await a.state.markMaintenanceRecoveryAdvised(command);
    const messages = a.intent.retainMessageMaintenanceAdvice([row('advice', 'Recover the saved restart.')], identity);
    const foreign = { ...messages[0].maintenanceRecoveryAdvice![0], rpcUrl: 'https://another-network.example' };
    const retained = a.intent.retainMessageMaintenanceAdvice([{ ...messages[0], maintenanceRecoveryAdvice: [foreign] }], identity);
    expect(retained[0].maintenanceRecoveryAdvice).toHaveLength(2);
    a.history.saveHistory(identity, retained, true);
    const b = await tab();
    b.history.loadHistory(identity);
    expect(b.intent.getMaintenanceRecoveryIntent(scope)?.idempotencyKey).toBe(command.idempotencyKey);
  });
});
