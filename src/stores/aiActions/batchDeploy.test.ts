import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolResult } from '../../ai/toolExecutor';
import { createAIStore } from '../aiStore';

// ---------------------------------------------------------------------------
// Deterministic IDs
// ---------------------------------------------------------------------------
let idCounter = 0;
vi.mock('./utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils')>();
  return {
    ...actual,
    generateMessageId: () => `msg_${++idCounter}`,
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../api/ollama', () => ({
  streamChat: vi.fn(),
  checkOllamaHealth: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue([]),
}));

const mockExecuteBatchDeploy = vi.fn<() => Promise<ToolResult>>();
const mockDeriveAppName = vi.fn((filename: string) =>
  filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-')
);
vi.mock('../../ai/toolExecutor/compositeTransactions', () => ({
  executeBatchDeploy: (...args: unknown[]) => mockExecuteBatchDeploy(...(args as [])),
  deriveAppName: (...args: unknown[]) => mockDeriveAppName(...(args as [])),
}));

vi.mock('../../utils/hash', () => ({
  sha256: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  toHex: vi.fn().mockReturnValue('010203'),
}));

vi.mock('../../utils/errors', () => ({
  logError: vi.fn(),
}));

vi.mock('../../ai/systemPrompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}));

vi.mock('../../config/runtimeConfig', () => ({
  runtimeConfig: {
    PUBLIC_OLLAMA_URL: 'http://localhost:11434',
    PUBLIC_OLLAMA_MODEL: 'llama3.2',
    PUBLIC_REST_URL: '',
    PUBLIC_RPC_URL: '',
    PUBLIC_WEB3AUTH_CLIENT_ID: '',
    PUBLIC_WEB3AUTH_NETWORK: '',
    PUBLIC_PWR_DENOM: '',
    PUBLIC_GAS_PRICE: '',
    PUBLIC_CHAIN_ID: '',
  },
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

vi.mock('../../registry/appRegistry', () => ({
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => null),
  findApp: vi.fn(() => null),
  getAppByLease: vi.fn(() => null),
  addApp: vi.fn(),
  updateApp: vi.fn(),
}));

import { logError } from '../../utils/errors';
import { sha256 } from '../../utils/hash';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Store = ReturnType<typeof createAIStore>;

const fakeClientManager = { fake: true } as unknown as NonNullable<ReturnType<typeof createAIStore>['getState']>['clientManager'];

function makeApps(count = 2): Array<{ label: string; manifest: object }> {
  return Array.from({ length: count }, (_, i) => ({
    label: `app-${i + 1}`,
    manifest: { version: '2', services: { web: { image: `nginx:${i + 1}` } } },
  }));
}

function setupStore(overrides: Record<string, unknown> = {}): Store {
  const store = createAIStore();
  store.setState({
    isConnected: true,
    isStreaming: false,
    lastMessageTime: 0,
    clientManager: fakeClientManager,
    address: 'manifest1test',
    signArbitrary: vi.fn(),
    settings: {
      ollamaEndpoint: 'http://localhost:11434',
      model: 'llama3.2',
      saveHistory: false,
      enableThinking: false,
    },
    ...overrides,
  });
  return store;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------
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

// ===========================================================================
// Tests
// ===========================================================================

describe('requestBatchDeploy', () => {
  // -----------------------------------------------------------------------
  // Guard clauses
  // -----------------------------------------------------------------------
  describe('guard clauses', () => {
    it('no-ops when isStreaming is true', async () => {
      const store = setupStore({ isStreaming: true });
      await store.getState().requestBatchDeploy(makeApps());
      expect(store.getState().messages).toHaveLength(0);
      expect(mockExecuteBatchDeploy).not.toHaveBeenCalled();
    });

    it('no-ops when not connected', async () => {
      const store = setupStore({ isConnected: false });
      await store.getState().requestBatchDeploy(makeApps());
      expect(store.getState().messages).toHaveLength(0);
      expect(mockExecuteBatchDeploy).not.toHaveBeenCalled();
    });

    it('does not mutate isStreaming on guard-clause exit', async () => {
      const store = setupStore({ isStreaming: true });
      await store.getState().requestBatchDeploy(makeApps());
      // isStreaming should remain true (guard returned before changing it)
      expect(store.getState().isStreaming).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Message sequence
  // -----------------------------------------------------------------------
  describe('message sequence', () => {
    it('creates user, assistant, and tool messages in order', async () => {
      const store = setupStore();
      mockExecuteBatchDeploy.mockResolvedValueOnce({
        success: true,
        requiresConfirmation: true,
        confirmationMessage: 'Deploy 2 apps?',
        pendingAction: { toolName: 'batch_deploy', args: { entries: [] } },
      } as unknown as ToolResult);

      await store.getState().requestBatchDeploy(makeApps(), 'Deploy my apps');

      const msgs = store.getState().messages;
      expect(msgs.length).toBeGreaterThanOrEqual(3);

      // msg_1 = user
      expect(msgs[0].role).toBe('user');
      expect(msgs[0].content).toBe('Deploy my apps');

      // msg_3 = assistant with toolCalls (msg_2 = syntheticToolCallId)
      expect(msgs[1].role).toBe('assistant');
      expect(msgs[1].toolCalls).toBeDefined();
      expect(msgs[1].toolCalls![0].function.name).toBe('batch_deploy');

      // msg_4 = tool
      expect(msgs[2].role).toBe('tool');
      expect(msgs[2].toolName).toBe('batch_deploy');
    });

    it('uses default message when originalMessage is not provided', async () => {
      const store = setupStore();
      mockExecuteBatchDeploy.mockResolvedValueOnce({
        success: true,
        requiresConfirmation: true,
        confirmationMessage: 'Deploy?',
        pendingAction: { toolName: 'batch_deploy', args: {} },
      } as unknown as ToolResult);

      await store.getState().requestBatchDeploy(makeApps());

      const msgs = store.getState().messages;
      expect(msgs[0].content).toBe('Deploy app-1, app-2');
    });
  });

  // -----------------------------------------------------------------------
  // Confirmation path
  // -----------------------------------------------------------------------
  describe('confirmation path', () => {
    it('sets pendingConfirmation when requiresConfirmation is true', async () => {
      const store = setupStore();
      mockExecuteBatchDeploy.mockResolvedValueOnce({
        success: true,
        requiresConfirmation: true,
        confirmationMessage: 'Deploy 2 apps for $0.50/hr?',
        pendingAction: { toolName: 'batch_deploy', args: { entries: [] } },
      } as unknown as ToolResult);

      await store.getState().requestBatchDeploy(makeApps());

      const state = store.getState();
      expect(state.pendingConfirmation).not.toBeNull();
      expect(state.pendingConfirmation!.action.toolName).toBe('batch_deploy');
    });

    it('pendingConfirmation.messageId matches the tool message id', async () => {
      const store = setupStore();
      mockExecuteBatchDeploy.mockResolvedValueOnce({
        success: true,
        requiresConfirmation: true,
        confirmationMessage: 'Deploy?',
        pendingAction: { toolName: 'batch_deploy', args: {} },
      } as unknown as ToolResult);

      await store.getState().requestBatchDeploy(makeApps());

      const state = store.getState();
      const toolMsg = state.messages.find(m => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(state.pendingConfirmation!.messageId).toBe(toolMsg!.id);
    });

    it('updates tool message with confirmation message', async () => {
      const store = setupStore();
      mockExecuteBatchDeploy.mockResolvedValueOnce({
        success: true,
        requiresConfirmation: true,
        confirmationMessage: 'Deploy 2 apps for $0.50/hr?',
        pendingAction: { toolName: 'batch_deploy', args: {} },
      } as unknown as ToolResult);

      await store.getState().requestBatchDeploy(makeApps());

      const state = store.getState();
      const toolMsg = state.messages.find(m => m.role === 'tool');
      expect(toolMsg!.content).toBe('Deploy 2 apps for $0.50/hr?');
      expect(toolMsg!.isStreaming).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Error result path
  // -----------------------------------------------------------------------
  describe('error result path', () => {
    it('shows error on tool message when executeBatchDeploy returns error', async () => {
      const store = setupStore();
      mockExecuteBatchDeploy.mockResolvedValueOnce({
        success: false,
        error: 'Insufficient credits',
      });

      await store.getState().requestBatchDeploy(makeApps());

      const state = store.getState();
      const toolMsg = state.messages.find(m => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toContain('Error: Insufficient credits');
      expect(toolMsg!.error).toBe('Insufficient credits');
      expect(toolMsg!.isStreaming).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Success without requiresConfirmation (contract test)
  // -----------------------------------------------------------------------
  describe('success without requiresConfirmation (contract test)', () => {
    it('falls through to else branch with a descriptive error message', async () => {
      // batch_deploy MUST go through confirmation. If executeBatchDeploy returns
      // success without requiresConfirmation, the else branch treats it as an
      // error with a fallback message (since result.error is undefined on success).
      const store = setupStore();
      mockExecuteBatchDeploy.mockResolvedValueOnce({
        success: true,
        data: { deployed: true },
      });

      await store.getState().requestBatchDeploy(makeApps());

      const state = store.getState();
      const toolMsg = state.messages.find(m => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toBe('Error: Batch deploy did not return a confirmation step');
      expect(toolMsg!.error).toBe('Batch deploy did not return a confirmation step');
      expect(toolMsg!.isStreaming).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Catch: exception during payload creation
  // -----------------------------------------------------------------------
  describe('catch: exception during payload creation', () => {
    it('sets error on tool message when sha256 throws', async () => {
      const store = setupStore();
      vi.mocked(sha256).mockRejectedValueOnce(new Error('Hash computation failed'));

      await store.getState().requestBatchDeploy(makeApps());

      const state = store.getState();
      const toolMsg = state.messages.find(m => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toContain('Batch deploy failed: Hash computation failed');
      expect(toolMsg!.error).toBe('Hash computation failed');
      expect(toolMsg!.isStreaming).toBe(false);
      expect(logError).toHaveBeenCalledWith('AIContext.requestBatchDeploy', expect.any(Error));
    });
  });

  // -----------------------------------------------------------------------
  // Catch: exception during executeBatchDeploy
  // -----------------------------------------------------------------------
  describe('catch: exception during executeBatchDeploy', () => {
    it('sets error on tool message when executeBatchDeploy throws', async () => {
      const store = setupStore();
      mockExecuteBatchDeploy.mockRejectedValueOnce(new Error('Network failure'));

      await store.getState().requestBatchDeploy(makeApps());

      const state = store.getState();
      const toolMsg = state.messages.find(m => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toContain('Batch deploy failed: Network failure');
      expect(toolMsg!.error).toBe('Network failure');
      expect(logError).toHaveBeenCalledWith('AIContext.requestBatchDeploy', expect.any(Error));
    });
  });

  // -----------------------------------------------------------------------
  // Catch: non-Error throw
  // -----------------------------------------------------------------------
  describe('catch: non-Error throw', () => {
    it('handles non-Error thrown values with "Unknown error" fallback', async () => {
      // When something other than an Error is thrown (e.g. a string), the
      // catch block falls back to 'Unknown error'. This throw happens after
      // toolMsgId is assigned (executeBatchDeploy runs after line 52), so
      // the catch block's `if (toolMsgId)` guard passes and the tool
      // message gets updated.
      const store = setupStore();
      mockExecuteBatchDeploy.mockImplementationOnce(() => {
        throw 'non-Error string'; // eslint-disable-line no-throw-literal
      });

      await store.getState().requestBatchDeploy(makeApps());

      const state = store.getState();
      expect(state.isStreaming).toBe(false);
      const toolMsg = state.messages.find(m => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toBe('Batch deploy failed: Unknown error');
      expect(toolMsg!.error).toBe('Unknown error');
    });
  });

  // -----------------------------------------------------------------------
  // Finally invariant
  // -----------------------------------------------------------------------
  describe('finally invariant', () => {
    it('clears isStreaming after success', async () => {
      const store = setupStore();
      mockExecuteBatchDeploy.mockResolvedValueOnce({
        success: true,
        requiresConfirmation: true,
        confirmationMessage: 'Deploy?',
        pendingAction: { toolName: 'batch_deploy', args: {} },
      } as unknown as ToolResult);

      await store.getState().requestBatchDeploy(makeApps());

      expect(store.getState().isStreaming).toBe(false);
    });

    it('clears isStreaming after error', async () => {
      const store = setupStore();
      mockExecuteBatchDeploy.mockRejectedValueOnce(new Error('fail'));

      await store.getState().requestBatchDeploy(makeApps());

      expect(store.getState().isStreaming).toBe(false);
    });

    it('clears isStreaming after thrown exception', async () => {
      const store = setupStore();
      vi.mocked(sha256).mockRejectedValueOnce(new Error('hash error'));

      await store.getState().requestBatchDeploy(makeApps());

      expect(store.getState().isStreaming).toBe(false);
    });
  });
});
