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
    expect(storage.length).toBe(0);
  });

  it('retains the barrier if consuming its stored entry fails', async () => {
    const state = await import('./maintenanceRecoveryIntent');
    state.rememberMaintenanceRecoveryIntent(command);
    storage.removeItem.mockImplementation(() => { throw new Error('Storage unavailable'); });
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
    expect(storage.length).toBe(others.length);
  });
});
