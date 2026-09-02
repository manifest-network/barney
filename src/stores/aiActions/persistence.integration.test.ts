/**
 * Integration test: PersistedMessageSchema + rehydrateChatHistory round-trip.
 *
 * `persistence.test.ts` mocks `validateChatHistory` as a passthrough — useful
 * for testing the rehydrate logic in isolation, but it can't catch a schema
 * strip-unknown-keys regression. This file imports the REAL validation module
 * so the full localStorage → schema → rehydrate path is exercised.
 *
 * If you find yourself adding a new transient flag to ChatMessage, also
 * whitelist it in `PersistedMessageSchema` and add a row here so the
 * round-trip stays covered.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  historyStorageKey,
  loadHistory,
  setupPersistenceSubscriptions,
} from './persistence';
import { createWalletIdentity } from '../../utils/walletIdentity';
import { createAIStore, type AIStore } from '../aiStore';

const IDENTITY = createWalletIdentity('manifest-test', 'manifest1alice')!;
const STORAGE_KEY_HISTORY = historyStorageKey(IDENTITY);

function storeHistory(messages: unknown[]): void {
  localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify({
    v: 1,
    data: { identity: IDENTITY, messages },
  }));
}

describe('persistence integration with real PersistedMessageSchema', () => {
  beforeEach(() => { localStorage.clear(); });

  it('round-trips awaitingConfirmation through schema and into rehydrate marker', () => {
    const persisted = [{
      id: 'm1',
      role: 'tool',
      content: 'Deploy "redis" on micro tier?',
      timestamp: 1,
      toolCallId: 'tc1',
      toolName: 'deploy_app',
      awaitingConfirmation: true,
    }];
    storeHistory(persisted);
    const result = loadHistory(IDENTITY);
    expect(result).toHaveLength(1);
    expect(result[0].error).toBe('Interrupted');
    expect(result[0].content).toBe('Interrupted — confirmation was pending when the page reloaded.');
    expect(result[0].awaitingConfirmation).toBe(false);
  });

  // Batch surface follow-up to 87b22b2. Persisted shape is identical to the
  // single-confirm round-trip — schema + rehydrate are agnostic to which
  // confirm flow set the flag. This test documents that the batch surface
  // (toolName: 'batch_deploy', "Deploy N apps: ..." content) is covered too.
  it('round-trips awaitingConfirmation on a batch_deploy owning message into rehydrate marker', () => {
    const persisted = [{
      id: 'm1',
      role: 'tool',
      content: 'Deploy 3 apps: alpha, beta, gamma?',
      timestamp: 1,
      toolCallId: 'tc_3',
      toolName: 'batch_deploy',
      awaitingConfirmation: true,
    }];
    storeHistory(persisted);
    const result = loadHistory(IDENTITY);
    expect(result).toHaveLength(1);
    expect(result[0].error).toBe('Interrupted');
    expect(result[0].content).toBe('Interrupted — confirmation was pending when the page reloaded.');
    expect(result[0].awaitingConfirmation).toBe(false);
  });

  it('closes an error-carrying failed re-plan confirmation after reload', () => {
    const persisted = [{
      id: 'm1',
      role: 'tool',
      content: 'Deploy 2 apps?',
      timestamp: 1,
      toolCallId: 'tc_2',
      toolName: 'batch_deploy',
      awaitingConfirmation: true,
      error: 'Tier catalog unavailable',
    }];
    storeHistory(persisted);

    const result = loadHistory(IDENTITY);

    expect(result[0]).toMatchObject({
      content: 'Interrupted — confirmation was pending when the page reloaded.',
      error: 'Interrupted',
      awaitingConfirmation: false,
    });
  });

  it('round-trips isStreaming=true into the interrupted-stream rehydrate branch', () => {
    const persisted = [{
      id: 'm1',
      role: 'assistant',
      content: 'half-streamed...',
      timestamp: 1,
      isStreaming: true,
    }];
    storeHistory(persisted);
    const result = loadHistory(IDENTITY);
    expect(result).toHaveLength(1);
    expect(result[0].isStreaming).toBe(false);
    expect(result[0].error).toMatch(/Interrupted — message was incomplete/);
  });

  it('round-trips an in-flight transaction into a broadcast-aware closure marker', () => {
    const persisted = [{
      id: 'm1',
      role: 'tool',
      content: 'Deploy "redis"?',
      timestamp: 1,
      toolCallId: 'tc1',
      toolName: 'deploy_app',
      transactionInFlight: true,
    }];
    storeHistory(persisted);

    const result = loadHistory(IDENTITY);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      transactionInFlight: false,
      awaitingConfirmation: false,
      isStreaming: false,
      error: expect.stringContaining('may already have been submitted'),
      content: expect.stringContaining('page reloaded'),
    });
  });

  it('round-trips local=true so synthesized messages keep the filter marker', () => {
    const persisted = [{
      id: 'm1',
      role: 'assistant',
      content: '/help canned text',
      timestamp: 1,
      local: true,
    }];
    storeHistory(persisted);
    const result = loadHistory(IDENTITY);
    expect(result).toHaveLength(1);
    expect(result[0].local).toBe(true);
  });
});

type Store = ReturnType<typeof createAIStore>;

function selectWallet(store: Store, chainId: string, address: string | undefined): void {
  const state = store.getState();
  state.setWalletContext({
    clientManager: null,
    address,
    signing: undefined,
    chainId,
  });
}

function addMessage(
  store: Store,
  message: Partial<AIStore['messages'][number]> & Pick<AIStore['messages'][number], 'id' | 'role' | 'content'>,
): void {
  store.getState().addMessage({
    timestamp: Date.now(),
    ...message,
  });
}

describe('wallet-scoped AI store history', () => {
  beforeEach(() => { localStorage.clear(); });

  it('isolates A → B → A, including tool data and local cards', () => {
    const store = createAIStore();
    const unsubscribe = setupPersistenceSubscriptions(store);

    try {
      selectWallet(store, 'chain-one', ' MANIFEST1ALICE ');
      addMessage(store, {
        id: 'alice-manifest',
        role: 'tool',
        content: '{"owner":"manifest1alice","manifest":"private"}',
        card: { type: 'help', data: null },
        local: true,
      });

      selectWallet(store, 'chain-one', 'manifest1bob');
      expect(store.getState().messages).toEqual([]);
      addMessage(store, {
        id: 'bob-only',
        role: 'user',
        content: 'wallet B private request',
      });

      selectWallet(store, 'chain-one', 'manifest1alice');
      expect(store.getState().messages).toEqual([
        expect.objectContaining({
          id: 'alice-manifest',
          content: '[help displayed to user]',
        }),
      ]);
      expect(store.getState().messages[0].card).toBeUndefined();
      expect(store.getState().messages.some((message) => message.id === 'bob-only')).toBe(false);

      selectWallet(store, 'chain-one', 'manifest1bob');
      expect(store.getState().messages).toEqual([
        expect.objectContaining({ id: 'bob-only', content: 'wallet B private request' }),
      ]);
    } finally {
      unsubscribe();
      store.getState().destroy();
    }
  });

  it('shows no history while disconnected and does not attach it to a later wallet', () => {
    const store = createAIStore();
    const unsubscribe = setupPersistenceSubscriptions(store);

    try {
      selectWallet(store, 'chain-one', 'manifest1alice');
      addMessage(store, {
        id: 'alice-only',
        role: 'user',
        content: 'wallet A secret',
      });

      selectWallet(store, 'chain-one', undefined);
      expect(store.getState().historyIdentity).toBeNull();
      expect(store.getState().messages).toEqual([]);

      // Even an out-of-band local row created while disconnected has no owner
      // and must not be adopted by the next connection.
      addMessage(store, {
        id: 'disconnected-row',
        role: 'assistant',
        content: 'unowned local state',
        local: true,
      });
      selectWallet(store, 'chain-one', 'manifest1bob');
      expect(store.getState().messages).toEqual([]);

      selectWallet(store, 'chain-one', 'manifest1alice');
      expect(store.getState().messages.map((message) => message.id)).toEqual(['alice-only']);
    } finally {
      unsubscribe();
      store.getState().destroy();
    }
  });

  it('isolates the same normalized address across two chain IDs', () => {
    const store = createAIStore();
    const unsubscribe = setupPersistenceSubscriptions(store);

    try {
      selectWallet(store, 'chain-one', 'MANIFEST1ALICE');
      addMessage(store, {
        id: 'chain-one-only',
        role: 'user',
        content: 'chain one',
      });

      selectWallet(store, 'chain-two', 'manifest1alice');
      expect(store.getState().messages).toEqual([]);
      addMessage(store, {
        id: 'chain-two-only',
        role: 'user',
        content: 'chain two',
      });

      selectWallet(store, 'chain-one', 'manifest1alice');
      expect(store.getState().messages.map((message) => message.id)).toEqual(['chain-one-only']);

      const chainOne = createWalletIdentity('chain-one', 'manifest1alice')!;
      const chainTwo = createWalletIdentity('chain-two', 'manifest1alice')!;
      expect(historyStorageKey(chainOne)).not.toBe(historyStorageKey(chainTwo));
      expect(localStorage.getItem(historyStorageKey(chainOne))).not.toBeNull();
      expect(localStorage.getItem(historyStorageKey(chainTwo))).not.toBeNull();
    } finally {
      unsubscribe();
      store.getState().destroy();
    }
  });

  it('clears only the active wallet and network transcript', () => {
    const store = createAIStore();
    const unsubscribe = setupPersistenceSubscriptions(store);
    const alice = createWalletIdentity('chain-one', 'manifest1alice')!;
    const bob = createWalletIdentity('chain-one', 'manifest1bob')!;

    try {
      selectWallet(store, alice.chainId, alice.address);
      addMessage(store, { id: 'alice-only', role: 'user', content: 'alice' });
      selectWallet(store, bob.chainId, bob.address);
      addMessage(store, { id: 'bob-only', role: 'user', content: 'bob' });
      selectWallet(store, alice.chainId, alice.address);

      store.getState().clearHistory();

      expect(store.getState().messages).toEqual([]);
      expect(localStorage.getItem(historyStorageKey(alice))).toBeNull();
      expect(localStorage.getItem(historyStorageKey(bob))).not.toBeNull();
    } finally {
      unsubscribe();
      store.getState().destroy();
    }
  });
});
