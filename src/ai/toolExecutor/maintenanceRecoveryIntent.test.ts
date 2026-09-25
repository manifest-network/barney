import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const command = {
  address: 'manifest1alice', chainId: 'chain-a', providerUrl: 'https://provider.example/api/fred',
  leaseUuid: '550e8400-e29b-41d4-a716-446655440000', operation: 'restart' as const,
  idempotencyKey: '11111111-1111-4111-8111-111111111111',
};
const secondKey = '22222222-2222-4222-8222-222222222222';
const intent = { operation: command.operation, idempotencyKey: command.idempotencyKey };

function tabStorage() {
  const entries = new Map<string, string>();
  return {
    entries,
    get length() { return entries.size; },
    key: vi.fn((index: number) => [...entries.keys()][index] ?? null),
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { entries.set(key, value); }),
    removeItem: vi.fn((key: string) => { entries.delete(key); }),
    clear: vi.fn(() => entries.clear()),
  };
}

describe('tab-local maintenance recovery intent', () => {
  let storage: ReturnType<typeof tabStorage>;
  beforeEach(() => {
    vi.resetModules();
    storage = tabStorage();
    vi.stubGlobal('sessionStorage', storage);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('retains memory evidence when quota prevents saving the intent', async () => {
    const state = await import('./maintenanceRecoveryIntent');
    storage.setItem.mockImplementation(() => { throw new Error('Quota exceeded'); });
    state.rememberMaintenanceRecoveryIntent(command);
    storage.getItem.mockImplementation(() => { throw new Error('Storage unavailable'); });
    expect(state.getMaintenanceRecoveryIntent(command)).toEqual(intent);
    expect(storage.length).toBe(0);
  });

  it('recovers persisted advice after a module reload and keeps only public identity', async () => {
    const state = await import('./maintenanceRecoveryIntent');
    const withManifest = { ...command, manifest: '{"PASSWORD":"private-secret"}' };
    state.rememberMaintenanceRecoveryIntent(withManifest);
    expect([...storage.entries.values()]).toEqual([JSON.stringify(intent)]);
    vi.resetModules();
    const reloaded = await import('./maintenanceRecoveryIntent');
    expect(reloaded.getMaintenanceRecoveryIntent(command)).toEqual(intent);
    expect(storage.length).toBe(1);
  });

  it('fails closed when a reloaded tab cannot read its stored advice', async () => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    vi.resetModules();
    const reloaded = await import('./maintenanceRecoveryIntent');
    storage.getItem.mockImplementation(() => { throw new Error('Storage unavailable'); });
    expect(() => reloaded.getMaintenanceRecoveryIntent(command)).toThrow('could not be read');
    expect(state.getMaintenanceRecoveryIntent(command)).toEqual(intent);
  });

  it('fails closed when storage is inaccessible at startup while preserving later memory evidence', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')!;
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
    try {
      const state = await import('./maintenanceRecoveryIntent');
      expect(() => state.getMaintenanceRecoveryIntent(command)).toThrow('could not be read');
      state.rememberMaintenanceRecoveryIntent(command);
      expect(state.getMaintenanceRecoveryIntent(command)).toEqual(intent);
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    }
  });

  it('consumes only the matching intent and leaves newer advice intact for stale approvals', async () => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    state.rememberMaintenanceRecoveryIntent({ ...command, idempotencyKey: secondKey });
    state.consumeMaintenanceRecoveryIntent(command, command.idempotencyKey);
    expect(state.getMaintenanceRecoveryIntent(command)).toEqual({ operation: 'restart', idempotencyKey: secondKey });
    expect(storage.length).toBe(1);
    state.consumeMaintenanceRecoveryIntent(command, secondKey);
    expect(state.getMaintenanceRecoveryIntent(command)).toBeUndefined();
    expect([...storage.entries.values()].map((value) => JSON.parse(value))).toEqual([{ c: [command.idempotencyKey, secondKey] }]);
  });

  it('acknowledges all observed source advice across reload without changing another tab', async () => {
    const state = await import('./maintenanceRecoveryIntent');
    const thirdKey = '33333333-3333-4333-8333-333333333333';
    const commands = [command, { ...command, idempotencyKey: secondKey }, { ...command, idempotencyKey: thirdKey }];
    const messages = commands.map((item, index) => ({ id: `advice-${index}`, role: 'tool' as const,
      content: 'Recover the saved command.', timestamp: index, maintenanceRecoveryAdvice: [state.maintenanceRecoveryAdvice(item)] }));
    for (const item of commands) state.rememberMaintenanceRecoveryIntent(item);
    expect(state.getMaintenanceRecoveryIntent(command)?.idempotencyKey).toBe(thirdKey);
    state.consumeMaintenanceRecoveryIntent(command, thirdKey);
    vi.resetModules();
    const reloaded = await import('./maintenanceRecoveryIntent');
    reloaded.restoreMessageMaintenanceAdvice(messages, { address: command.address, chainId: command.chainId });
    expect(reloaded.getMaintenanceRecoveryIntent(command)).toBeUndefined();
    const nextKey = '44444444-4444-4444-8444-444444444444';
    reloaded.rememberMaintenanceRecoveryIntent({ ...command, idempotencyKey: nextKey });
    reloaded.consumeMaintenanceRecoveryIntent(command, thirdKey);
    expect(reloaded.getMaintenanceRecoveryIntent(command)?.idempotencyKey).toBe(nextKey);

    vi.stubGlobal('sessionStorage', tabStorage());
    vi.resetModules();
    const otherTab = await import('./maintenanceRecoveryIntent');
    otherTab.restoreMessageMaintenanceAdvice(messages, { address: command.address, chainId: command.chainId });
    expect(otherTab.getMaintenanceRecoveryIntent(command)?.idempotencyKey).toBe(command.idempotencyKey);
    otherTab.consumeMaintenanceRecoveryIntent(command, command.idempotencyKey);
    vi.resetModules();
    const otherReloaded = await import('./maintenanceRecoveryIntent');
    otherReloaded.restoreMessageMaintenanceAdvice(messages, { address: command.address, chainId: command.chainId });
    expect(otherReloaded.getMaintenanceRecoveryIntent(command)).toBeUndefined();
  });

  it('durably consumes observed advice at a full UTF-16 storage quota by shrinking the same entry', async () => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    state.rememberMaintenanceRecoveryIntent({ ...command, idempotencyKey: secondKey });
    const bytes = () => [...storage.entries].reduce((total, [key, value]) => total + 2 * (key.length + value.length), 0);
    const limit = bytes();
    storage.setItem.mockImplementation((key, value) => {
      const next = bytes() - 2 * ((storage.entries.get(key)?.length ?? 0) + (storage.entries.has(key) ? key.length : 0)) + 2 * (key.length + value.length);
      if (next > limit) throw new DOMException('Quota', 'QuotaExceededError');
      storage.entries.set(key, value);
    });
    state.consumeMaintenanceRecoveryIntent(command, secondKey);
    expect(bytes()).toBeLessThan(limit);
    expect(storage.length).toBe(1);
    vi.resetModules();
    const reloaded = await import('./maintenanceRecoveryIntent');
    reloaded.rememberMaintenanceRecoveryIntent(command);
    reloaded.rememberMaintenanceRecoveryIntent({ ...command, idempotencyKey: secondKey });
    expect(reloaded.getMaintenanceRecoveryIntent(command)).toBeUndefined();
  });

  it('does not overwrite unknown stored evidence when a remembered guard can only be read from memory', async () => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    const before = [...storage.entries];
    storage.setItem.mockClear();
    storage.getItem.mockImplementation(() => { throw new Error('Storage unavailable'); });
    state.consumeMaintenanceRecoveryIntent(command, command.idempotencyKey);
    state.rememberMaintenanceRecoveryIntent(command, true);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect([...storage.entries]).toEqual(before);
    expect(state.getMaintenanceRecoveryIntent(command)).toEqual(intent);
  });

  it('does not overwrite a session entry with an unknown evidence field', async () => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    const key = storage.key(0)!;
    const raw = JSON.stringify({ c: [command.idempotencyKey], unknownActive: secondKey });
    storage.setItem(key, raw);
    expect(() => state.getMaintenanceRecoveryIntent(command)).toThrow('unreadable');
    state.rememberMaintenanceRecoveryIntent({ ...command, idempotencyKey: secondKey });
    expect(storage.entries.get(key)).toBe(raw);
  });

  it.each(['c', 'h'])('fails closed on malformed %s identity lists', async (field) => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    const key = storage.key(0)!;
    storage.setItem(key, JSON.stringify({ ...intent, [field]: ['not-a-uuid'] }));
    expect(() => state.getMaintenanceRecoveryIntent(command)).toThrow('unreadable');
    expect(() => state.consumeMaintenanceRecoveryIntent(command, command.idempotencyKey)).toThrow('unreadable');
    expect(JSON.parse(storage.entries.get(key)!)[field]).toEqual(['not-a-uuid']);
  });

  it.each([false, true])('promotes late actionable advice when the active command was never sent (write fails=%s)', async (writeFails) => {
    const state = await import('./maintenanceRecoveryIntent');
    const unsent = { ...command, idempotencyKey: secondKey };
    state.rememberMaintenanceRecoveryIntent(unsent);
    state.rememberMaintenanceRecoveryIntent({ ...command, operation: 'update' }, true);
    expect(state.getMaintenanceRecoveryIntent(command)?.idempotencyKey).toBe(secondKey);
    const prior = [...storage.entries];
    if (writeFails) storage.setItem.mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
    state.retireUnsentMaintenanceRecoveryIntent(unsent, secondKey);
    expect(state.getMaintenanceRecoveryIntent(command)).toEqual({ operation: 'update', idempotencyKey: command.idempotencyKey });
    if (writeFails) expect([...storage.entries]).toEqual(prior);
    storage.setItem.mockImplementation((key, value) => { storage.entries.set(key, value); });
    vi.resetModules();
    const reloaded = await import('./maintenanceRecoveryIntent');
    reloaded.syncMaintenanceNeverSentProofs(command, [secondKey]);
    expect(reloaded.getMaintenanceRecoveryIntent(command)).toEqual({ operation: 'update', idempotencyKey: command.idempotencyKey });
    reloaded.consumeMaintenanceRecoveryIntent(command, secondKey);
    expect(reloaded.getMaintenanceRecoveryIntent(command)?.idempotencyKey).toBe(command.idempotencyKey);
    reloaded.consumeMaintenanceRecoveryIntent(command, command.idempotencyKey);
    expect(reloaded.getMaintenanceRecoveryIntent(command)).toBeUndefined();
  });

  it.each(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'])('retries a compact durable acknowledgement after %s rejects an in-place replacement', async (quotaName) => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    storage.setItem.mockImplementation((key, value) => {
      if (storage.entries.has(key)) throw new DOMException('Quota', quotaName);
      storage.entries.set(key, value);
    });
    state.consumeMaintenanceRecoveryIntent(command, command.idempotencyKey);
    expect(storage.removeItem).toHaveBeenCalledOnce();
    expect(state.getMaintenanceRecoveryIntent(command)).toBeUndefined();
    vi.resetModules();
    const reloaded = await import('./maintenanceRecoveryIntent');
    reloaded.rememberMaintenanceRecoveryIntent(command);
    expect(reloaded.getMaintenanceRecoveryIntent(command)).toBeUndefined();
  });

  it.each(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'])('releases only the acknowledged live guard after %s rejects all writes, then conservatively restores a surviving source after reload', async (quotaName) => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    storage.setItem.mockImplementation(() => { throw new DOMException('Quota', quotaName); });
    state.consumeMaintenanceRecoveryIntent(command, command.idempotencyKey);
    expect(storage.length).toBe(0);
    for (let index = 0; index < 3; index++) {
      expect(state.getMaintenanceRecoveryIntent(command)).toBeUndefined();
      state.rememberMaintenanceRecoveryIntent(command);
    }
    expect(state.getMaintenanceRecoveryIntent(command)).toBeUndefined();
    state.rememberMaintenanceRecoveryIntent({ ...command, idempotencyKey: secondKey });
    expect(state.getMaintenanceRecoveryIntent(command)?.idempotencyKey).toBe(secondKey);
    state.consumeMaintenanceRecoveryIntent(command, command.idempotencyKey);
    expect(state.getMaintenanceRecoveryIntent(command)?.idempotencyKey).toBe(secondKey);
    const messages = [{ id: 'source', role: 'tool' as const, content: 'Recover saved restart.', timestamp: 1,
      maintenanceRecoveryAdvice: [state.maintenanceRecoveryAdvice(command)] }];
    vi.resetModules();
    const reloaded = await import('./maintenanceRecoveryIntent');
    reloaded.restoreMessageMaintenanceAdvice(messages, { address: command.address, chainId: command.chainId });
    expect(reloaded.getMaintenanceRecoveryIntent(command)).toEqual(intent);
  });

  it.each(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'])('keeps the guard if %s fallback cannot remove the matching saved entry', async (quotaName) => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    storage.setItem.mockImplementation(() => { throw new DOMException('Quota', quotaName); });
    storage.removeItem.mockImplementation(() => { throw new Error('Removal denied'); });
    state.consumeMaintenanceRecoveryIntent(command, command.idempotencyKey);
    expect(state.getMaintenanceRecoveryIntent(command)).toEqual(intent);
  });

  it.each(['SecurityError', 'NS_ERROR_FAILURE'])('does not remove the guard for non-quota DOMException %s', async (name) => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    storage.setItem.mockImplementation(() => { throw new DOMException('Storage unavailable', name); });
    state.consumeMaintenanceRecoveryIntent(command, command.idempotencyKey);
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(state.getMaintenanceRecoveryIntent(command)).toEqual(intent);
  });

  it('retains the barrier if consuming its stored entry fails', async () => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    storage.setItem.mockImplementation(() => { throw new Error('Storage unavailable'); });
    state.consumeMaintenanceRecoveryIntent(command, command.idempotencyKey);
    expect(state.getMaintenanceRecoveryIntent(command)).toEqual(intent);
    expect(storage.length).toBe(1);
  });

  it.each(['read failure', 'malformed value'] as const)('does not erase unknown stored advice during never-sent retirement after %s', async (failure) => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    const key = storage.key(0)!;
    if (failure === 'read failure') storage.getItem.mockImplementation(() => { throw new Error('Storage unavailable'); });
    else storage.setItem(key, '{malformed-newer-advice');
    state.retireUnsentMaintenanceRecoveryIntent(command, command.idempotencyKey);
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.entries.has(key)).toBe(true);
    expect(() => state.getMaintenanceRecoveryIntent(command)).toThrow(/could not be read|unreadable/);
  });

  it('does not let late never-sent advice replace a newer retained intent', async () => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    state.retireUnsentMaintenanceRecoveryIntent(command, command.idempotencyKey);
    state.rememberMaintenanceRecoveryIntent({ ...command, idempotencyKey: secondKey });
    state.rememberMaintenanceRecoveryIntent(command);
    expect(state.getMaintenanceRecoveryIntent(command)?.idempotencyKey).toBe(secondKey);
  });

  it('preserves unreadable prior storage when unsent advice is first observed and then retired', async () => {
    const original = await import('./maintenanceRecoveryIntent');
    original.rememberMaintenanceRecoveryIntent(command);
    const key = storage.key(0)!;
    const prior = storage.entries.get(key);
    vi.resetModules();
    const fresh = await import('./maintenanceRecoveryIntent');
    storage.getItem.mockImplementation(() => { throw new Error('Storage temporarily unreadable'); });
    fresh.rememberMaintenanceRecoveryIntent({ ...command, idempotencyKey: secondKey }, true);
    expect(fresh.getMaintenanceRecoveryIntent(command)?.idempotencyKey).toBe(secondKey);
    fresh.retireUnsentMaintenanceRecoveryIntent(command, secondKey);
    expect(storage.setItem).toHaveBeenCalledOnce();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.entries.get(key)).toBe(prior);
    expect(() => fresh.getMaintenanceRecoveryIntent(command)).toThrow('could not be read');
    storage.getItem.mockImplementation((key) => storage.entries.get(key) ?? null);
    expect(fresh.getMaintenanceRecoveryIntent(command)?.idempotencyKey).toBe(command.idempotencyKey);
  });

  it('captures new advice after a memory-only never-sent guard while prior storage remains unreadable', async () => {
    const original = await import('./maintenanceRecoveryIntent');
    original.rememberMaintenanceRecoveryIntent(command);
    const storageKey = storage.key(0)!;
    const prior = storage.entries.get(storageKey);
    vi.resetModules();
    const fresh = await import('./maintenanceRecoveryIntent');
    storage.getItem.mockImplementation(() => { throw new Error('Storage temporarily unreadable'); });
    fresh.rememberMaintenanceRecoveryIntent({ ...command, idempotencyKey: secondKey }, true);
    fresh.retireUnsentMaintenanceRecoveryIntent(command, secondKey);
    const nextKey = '33333333-3333-4333-8333-333333333333';
    fresh.rememberMaintenanceRecoveryIntent({ ...command, idempotencyKey: nextKey }, true);
    expect(fresh.getMaintenanceRecoveryIntent(command)?.idempotencyKey).toBe(nextKey);
    fresh.retireUnsentMaintenanceRecoveryIntent(command, nextKey);
    expect(() => fresh.getMaintenanceRecoveryIntent(command)).toThrow('could not be read');
    expect(storage.setItem).toHaveBeenCalledOnce();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.entries.get(storageKey)).toBe(prior);
    storage.getItem.mockImplementation((key) => storage.entries.get(key) ?? null);
    expect(fresh.getMaintenanceRecoveryIntent(command)?.idempotencyKey).toBe(command.idempotencyKey);
  });

  it('does not erase an entry that becomes malformed before consumption', async () => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    const key = storage.key(0)!;
    storage.setItem(key, '{malformed');
    expect(() => state.consumeMaintenanceRecoveryIntent(command, command.idempotencyKey)).toThrow('unreadable');
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe('{malformed');
    storage.setItem(key, JSON.stringify(intent));
    expect(state.getMaintenanceRecoveryIntent(command)).toEqual(intent);
  });

  it('keeps only the latest advice per lease and does not clear other wallets, chains, providers, or leases', async () => {
    const state = await import('./maintenanceRecoveryIntent');
    const others = [
      { ...command, address: 'manifest1bob' }, { ...command, chainId: 'chain-b' },
      { ...command, providerUrl: 'https://other.example/api/fred' }, { ...command, leaseUuid: crypto.randomUUID() },
    ];
    for (const scope of others) state.rememberMaintenanceRecoveryIntent(scope);
    for (let index = 0; index < 20; index++) state.rememberMaintenanceRecoveryIntent({ ...command, idempotencyKey: crypto.randomUUID() });
    state.rememberMaintenanceRecoveryIntent(command);
    expect(storage.length).toBe(others.length + 1);
    state.consumeMaintenanceRecoveryIntent({ ...command, address: ' MANIFEST1ALICE ', providerUrl: `${command.providerUrl}/` }, command.idempotencyKey);
    expect(state.getMaintenanceRecoveryIntent(command)).toBeUndefined();
    for (const scope of others) expect(state.getMaintenanceRecoveryIntent(scope)).toEqual(intent);
    expect(storage.length).toBe(others.length + 1); // This tab's consumed UUID stays durable.
  });
});
