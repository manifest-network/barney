import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAIStore } from '../aiStore';
import type { AppEntry } from '../../registry/appRegistry';

// ---------------------------------------------------------------------------
// Deterministic IDs
// ---------------------------------------------------------------------------
let idCounter = 0;
const findApp = vi.fn<(address: string, name: string) => AppEntry | null>();
vi.mock('./utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils')>();
  return {
    ...actual,
    generateMessageId: () => `msg_${++idCounter}`,
    // Override registry access so we don't touch real localStorage.
    getAppRegistryAccess: () => ({
      getApps: vi.fn(() => []),
      getApp: vi.fn(() => null),
      findApp,
      getAppByLease: vi.fn(() => null),
      addApp: vi.fn(),
      updateApp: vi.fn(),
    }),
  };
});

// Stub modules pulled in transitively via aiStore so we don't hit the real
// chain / network / system-prompt code paths.
vi.mock('../../api/morpheus', () => ({
  streamChat: vi.fn(),
  checkApiHealth: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../ai/systemPrompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}));
vi.mock('../../ai/validation', () => ({
  validateUserInput: vi.fn((input: string) => input?.trim() || null),
  validateEndpointUrl: vi.fn((url: string) => url),
  validateSettings: vi.fn((data: unknown) => data),
  validateChatHistory: vi.fn(() => []),
  sanitizeToolArgs: vi.fn((args: unknown) => args),
  isPrivateHost: vi.fn(() => false),
}));
vi.mock('../../ai/tools', () => ({
  AI_TOOLS: [],
  isValidToolName: vi.fn(() => true),
  getToolCallDescription: vi.fn(() => 'tool desc'),
}));
vi.mock('../../utils/errors', () => ({
  logError: vi.fn(),
}));

type Store = ReturnType<typeof createAIStore>;

function makeApp(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    name: 'all',
    leaseUuid: 'lease-stop-1',
    size: 'micro',
    providerUuid: 'p-1',
    providerUrl: 'https://fred.example.com',
    createdAt: 1000,
    status: 'running',
    ...overrides,
  };
}

function setupStore(overrides: Record<string, unknown> = {}): Store {
  const store = createAIStore();
  store.setState({
    isConnected: true,
    isStreaming: false,
    address: 'manifest1test',
    ...overrides,
  });
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  idCounter = 0;
  vi.clearAllMocks();
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 0; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('requestStopApp', () => {
  // Locks in the executor's single-app branch discriminator: when args has
  // app_name + leaseUuid (and NO `entries`), `executeConfirmedStopApp`
  // falls through the bulk branch (line 1959) and takes the single-app
  // close-lease path. The whole point of the direct-action fix is that
  // `'all'` never reaches `resolveMultiAppNames` — locking the shape here
  // protects against future refactors accidentally producing the bulk shape.
  it('sets pendingConfirmation with single-app args shape (no entries)', () => {
    findApp.mockReturnValue(makeApp());
    const store = setupStore();

    store.getState().requestStopApp('all');

    const state = store.getState();
    expect(state.pendingConfirmation).not.toBeNull();
    expect(state.pendingConfirmation!.action.toolName).toBe('stop_app');
    expect(state.pendingConfirmation!.action.args).toEqual({
      app_name: 'all',
      leaseUuid: 'lease-stop-1',
    });
    expect(state.pendingConfirmation!.action.args).not.toHaveProperty('entries');
  });

  it('appends synthetic user + assistant + tool messages with awaitingConfirmation', () => {
    findApp.mockReturnValue(makeApp({ name: 'redis' }));
    const store = setupStore();

    store.getState().requestStopApp('redis');

    const msgs = store.getState().messages;
    expect(msgs).toHaveLength(3);

    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('Stop redis');

    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].toolCalls).toBeDefined();
    expect(msgs[1].toolCalls![0].function.name).toBe('stop_app');
    expect(msgs[1].toolCalls![0].function.arguments).toEqual({ app_name: 'redis' });

    expect(msgs[2].role).toBe('tool');
    expect(msgs[2].toolName).toBe('stop_app');
    expect(msgs[2].awaitingConfirmation).toBe(true);
    expect(msgs[2].isStreaming).toBe(false);
    // The pendingConfirmation.messageId must point at this tool message
    // for the existing confirm-flow rehydrate logic.
    expect(store.getState().pendingConfirmation!.messageId).toBe(msgs[2].id);
  });

  it('is a silent no-op when the app is unknown to the registry', () => {
    findApp.mockReturnValue(null);
    const store = setupStore();

    store.getState().requestStopApp('does-not-exist');

    expect(store.getState().messages).toHaveLength(0);
    expect(store.getState().pendingConfirmation).toBeNull();
  });

  it('is a silent no-op when the app is already stopped', () => {
    findApp.mockReturnValue(makeApp({ status: 'stopped' }));
    const store = setupStore();

    store.getState().requestStopApp('all');

    expect(store.getState().messages).toHaveLength(0);
    expect(store.getState().pendingConfirmation).toBeNull();
  });

  it('is a silent no-op when isStreaming is true', () => {
    findApp.mockReturnValue(makeApp());
    const store = setupStore({ isStreaming: true });

    store.getState().requestStopApp('all');

    expect(store.getState().messages).toHaveLength(0);
    expect(store.getState().pendingConfirmation).toBeNull();
    expect(findApp).not.toHaveBeenCalled();
  });

  // Regression: PR #93 Copilot 3248436550. Without this gate, clicking Stop
  // while another confirmation is open would overwrite pendingConfirmation
  // and orphan the prior tool message (awaitingConfirmation: true, no
  // confirm/cancel path → chat wedged). The fix matches standard modal
  // overlay UX: background clicks while a modal is open are inert. The
  // referential `.toBe(priorConfirmation)` assertion is the strongest
  // form — guarantees no overwrite at all, not just same-shape.
  it('is a silent no-op when another confirmation is already pending', () => {
    findApp.mockReturnValue(makeApp({ name: 'redis' }));
    const store = setupStore();
    const priorConfirmation = {
      id: 'prior-1',
      action: {
        id: 'prior-action',
        toolName: 'deploy_app',
        args: { app_name: 'web' },
        description: 'Deploy web?',
      },
      messageId: 'msg-prior',
    };
    store.setState({ pendingConfirmation: priorConfirmation });

    store.getState().requestStopApp('redis');

    expect(store.getState().messages).toHaveLength(0);
    // Critically: the prior confirmation is preserved by reference, not
    // overwritten with a new stop_app one.
    expect(store.getState().pendingConfirmation).toBe(priorConfirmation);
    expect(findApp).not.toHaveBeenCalled();  // bail-out before registry lookup
  });

  it('is a silent no-op when not connected or address is missing', () => {
    findApp.mockReturnValue(makeApp());

    const disconnected = setupStore({ isConnected: false });
    disconnected.getState().requestStopApp('all');
    expect(disconnected.getState().messages).toHaveLength(0);
    expect(disconnected.getState().pendingConfirmation).toBeNull();

    const noAddress = setupStore({ address: undefined });
    noAddress.getState().requestStopApp('all');
    expect(noAddress.getState().messages).toHaveLength(0);
    expect(noAddress.getState().pendingConfirmation).toBeNull();

    expect(findApp).not.toHaveBeenCalled();
  });
});
