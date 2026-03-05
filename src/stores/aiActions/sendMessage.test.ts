import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamResult } from '../../ai/streamUtils';
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
    createAssistantMessage: () => ({
      id: `msg_${++idCounter}`,
      role: 'assistant' as const,
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    }),
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../api/morpheus', () => ({
  streamChat: vi.fn(),
  checkApiHealth: vi.fn().mockResolvedValue(true),
}));

const mockProcessStream = vi.fn<() => Promise<StreamResult>>();
vi.mock('../../ai/streamUtils', () => ({
  processStreamWithTimeout: (...args: unknown[]) => mockProcessStream(...(args as [])),
}));

vi.mock('../../ai/validation', () => ({
  validateUserInput: vi.fn((input: string) => {
    const trimmed = input?.trim?.();
    return trimmed && trimmed.length > 0 ? trimmed : null;
  }),
  validateEndpointUrl: vi.fn((url: string) => url),
  validateSettings: vi.fn((data: unknown) => data),
  validateChatHistory: vi.fn(() => []),
  sanitizeToolArgs: vi.fn((args: unknown) => args),
  isPrivateHost: vi.fn(() => false),
}));

const mockProcessToolCalls = vi.fn();
vi.mock('./toolExecution', () => ({
  processToolCallsFn: (...args: unknown[]) => mockProcessToolCalls(...args),
}));

vi.mock('../../utils/errors', () => ({
  logError: vi.fn(),
}));

vi.mock('../../ai/tools', () => ({
  AI_TOOLS: [],
  isValidToolName: vi.fn(() => true),
  getToolCallDescription: vi.fn(() => 'tool desc'),
}));

vi.mock('../../ai/systemPrompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}));

vi.mock('../../config/runtimeConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/runtimeConfig')>();
  return { ...actual, runtimeConfig: { ...actual.runtimeConfig, PUBLIC_MORPHEUS_MODEL: 'minimax-m2.5' } };
});

vi.mock('../../registry/appRegistry', () => ({
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => null),
  findApp: vi.fn(() => null),
  getAppByLease: vi.fn(() => null),
  addApp: vi.fn(),
  updateApp: vi.fn(),
}));

import { logError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStreamResult(overrides: Partial<StreamResult> = {}): StreamResult {
  return {
    content: 'hello',
    thinking: '',
    toolCalls: [],
    ...overrides,
  };
}

type Store = ReturnType<typeof createAIStore>;

function setupStore(overrides: Record<string, unknown> = {}): Store {
  const store = createAIStore();
  store.setState({
    isConnected: true,
    isStreaming: false,
    lastMessageTime: 0,
    settings: {
      saveHistory: false,
    },
    address: 'manifest1test',
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

describe('sendMessage', () => {
  // -----------------------------------------------------------------------
  // Guard clauses
  // -----------------------------------------------------------------------
  describe('guard clauses', () => {
    it('returns early when input is empty', async () => {
      const store = setupStore();
      await store.getState().sendMessage('');
      expect(store.getState().isStreaming).toBe(false);
      expect(store.getState().messages).toHaveLength(0);
    });

    it('returns early when input is only whitespace', async () => {
      const store = setupStore();
      await store.getState().sendMessage('   ');
      expect(store.getState().isStreaming).toBe(false);
      expect(store.getState().messages).toHaveLength(0);
    });

    it('returns early when not connected', async () => {
      const store = setupStore({ isConnected: false });
      await store.getState().sendMessage('hello');
      expect(store.getState().isStreaming).toBe(false);
      expect(store.getState().messages).toHaveLength(0);
    });

    it('returns early when already streaming', async () => {
      const store = setupStore({ isStreaming: true });
      const before = store.getState().messages.length;
      await store.getState().sendMessage('hello');
      expect(store.getState().messages).toHaveLength(before);
    });

    it('returns early within debounce window', async () => {
      const store = setupStore({ lastMessageTime: 900 });
      // now = 1000, last = 900, diff = 100 < 300 (AI_MESSAGE_DEBOUNCE_MS)
      await store.getState().sendMessage('hello');
      expect(store.getState().messages).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Abort controller lifecycle
  // -----------------------------------------------------------------------
  describe('abort controller lifecycle', () => {
    it('aborts the old abort controller before creating a new one', async () => {
      const oldAbort = new AbortController();
      const abortSpy = vi.spyOn(oldAbort, 'abort');
      const store = setupStore({ abortController: oldAbort });

      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().sendMessage('hello');

      expect(abortSpy).toHaveBeenCalled();
    });

    it('nulls abortController in finally block', async () => {
      const store = setupStore();
      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().sendMessage('hello');

      expect(store.getState().abortController).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Deploy progress clearing
  // -----------------------------------------------------------------------
  describe('deploy progress clearing', () => {
    it('clears deploy progress when phase is ready', async () => {
      const store = setupStore({ deployProgress: { phase: 'ready' } });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().sendMessage('hello');

      expect(store.getState().deployProgress).toBeNull();
    });

    it('clears deploy progress when phase is failed', async () => {
      const store = setupStore({ deployProgress: { phase: 'failed' } });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().sendMessage('hello');

      expect(store.getState().deployProgress).toBeNull();
    });

    it('preserves deploy progress when phase is creating_lease', async () => {
      const progress = { phase: 'creating_lease' as const };
      const store = setupStore({ deployProgress: progress });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().sendMessage('hello');

      // The deploy progress should not be cleared — it's still active
      // (It may be null at the end because the finally doesn't touch it,
      //  but the clearing logic should NOT have wiped it during setup)
      expect(store.getState().deployProgress).toEqual(progress);
    });

    it('preserves deploy progress when phase is uploading', async () => {
      const progress = { phase: 'uploading' as const };
      const store = setupStore({ deployProgress: progress });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().sendMessage('hello');

      expect(store.getState().deployProgress).toEqual(progress);
    });
  });

  // -----------------------------------------------------------------------
  // Stream error branch
  // -----------------------------------------------------------------------
  describe('stream error branch', () => {
    it('sets error on assistant message and stops streaming', async () => {
      const store = setupStore();
      mockProcessStream.mockResolvedValueOnce(
        makeStreamResult({ error: 'network error', content: 'partial' })
      );

      await store.getState().sendMessage('hello');

      const state = store.getState();
      expect(state.isStreaming).toBe(false);
      // Find the assistant message (msg_2 = initial assistant message)
      const assistantMsg = state.messages.find(m => m.id === 'msg_2');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.error).toBe('network error');
      expect(assistantMsg!.content).toBe('partial');
      expect(assistantMsg!.isStreaming).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Empty response branch
  // -----------------------------------------------------------------------
  describe('empty response branch', () => {
    it('sets fallback message with empty_response error when no content and no tool calls', async () => {
      const store = setupStore();
      mockProcessStream.mockResolvedValueOnce(
        makeStreamResult({ content: '', toolCalls: [] })
      );

      await store.getState().sendMessage('hello');

      const state = store.getState();
      const assistantMsg = state.messages.find(m => m.id === 'msg_2');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.error).toBe('empty_response');
      expect(assistantMsg!.content).toContain('couldn\'t generate a response');
      expect(assistantMsg!.isStreaming).toBe(false);
    });

    it('does not set error when content is present and no tool calls', async () => {
      const store = setupStore();
      mockProcessStream.mockResolvedValueOnce(
        makeStreamResult({ content: 'Valid response', toolCalls: [] })
      );

      await store.getState().sendMessage('hello');

      const state = store.getState();
      const assistantMsg = state.messages.find(m => m.id === 'msg_2');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toBe('Valid response');
      expect(assistantMsg!.error).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Tool call loop control
  // -----------------------------------------------------------------------
  describe('tool call loop control', () => {
    it('stops loop when shouldContinue is false', async () => {
      const store = setupStore();
      mockProcessStream.mockResolvedValueOnce(
        makeStreamResult({ toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'list_apps', arguments: {} } }] })
      );
      mockProcessToolCalls.mockResolvedValueOnce({ shouldContinue: false });

      await store.getState().sendMessage('hello');

      expect(mockProcessStream).toHaveBeenCalledTimes(1);
      expect(mockProcessToolCalls).toHaveBeenCalledTimes(1);
    });

    it('continues loop when shouldContinue is true', async () => {
      const store = setupStore();
      // First iteration: tool calls → continue
      mockProcessStream.mockResolvedValueOnce(
        makeStreamResult({ toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'list_apps', arguments: {} } }] })
      );
      mockProcessToolCalls.mockResolvedValueOnce({
        shouldContinue: true,
        nextAssistantMessageId: 'msg_next',
      });

      // Second iteration: no tool calls → finish
      mockProcessStream.mockResolvedValueOnce(
        makeStreamResult({ content: 'Done', toolCalls: [] })
      );

      await store.getState().sendMessage('hello');

      expect(mockProcessStream).toHaveBeenCalledTimes(2);
      expect(mockProcessToolCalls).toHaveBeenCalledTimes(1);
    });

    it('stops at max iterations and sets error', async () => {
      const store = setupStore();

      // Each iteration returns tool calls and shouldContinue = true.
      // The mock must add the next assistant message to the store
      // (like the real processToolCallsFn does) so the outer loop can
      // update it when max iterations is reached.
      for (let i = 0; i < 10; i++) {
        mockProcessStream.mockResolvedValueOnce(
          makeStreamResult({ toolCalls: [{ id: `tc${i}`, type: 'function', function: { name: 'list_apps', arguments: {} } }] })
        );
      }
      mockProcessToolCalls.mockImplementation(async (get: () => { messages: { id: string; role: string; content: string; timestamp: number; isStreaming: boolean }[] }, set: (p: Record<string, unknown>) => void) => {
        const nextId = `msg_iter_${mockProcessToolCalls.mock.calls.length}`;
        const newMsg = { id: nextId, role: 'assistant' as const, content: '', timestamp: Date.now(), isStreaming: true };
        set({ messages: [...get().messages, newMsg] });
        return { shouldContinue: true, nextAssistantMessageId: nextId };
      });

      await store.getState().sendMessage('hello');

      expect(mockProcessStream).toHaveBeenCalledTimes(10);
      expect(mockProcessToolCalls).toHaveBeenCalledTimes(10);

      const state = store.getState();
      const errorMsg = state.messages.find(m =>
        m.error === 'max_tool_iterations_reached'
      );
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.content).toContain('maximum number of tool calls');
      expect(errorMsg!.isStreaming).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Catch: timeout vs generic
  // -----------------------------------------------------------------------
  describe('catch block', () => {
    it('shows timeout message when stream throws timeout error', async () => {
      const store = setupStore();
      mockProcessStream.mockRejectedValueOnce(new Error('Stream timeout: no response received'));

      await store.getState().sendMessage('hello');

      const state = store.getState();
      const assistantMsg = state.messages.find(m => m.id === 'msg_2');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toContain('took too long to respond');
      expect(assistantMsg!.error).toContain('timeout');
      expect(logError).toHaveBeenCalledWith('AIContext.sendMessage', expect.any(Error));
    });

    it('shows generic message for non-timeout errors', async () => {
      const store = setupStore();
      mockProcessStream.mockRejectedValueOnce(new Error('Connection refused'));

      await store.getState().sendMessage('hello');

      const state = store.getState();
      const assistantMsg = state.messages.find(m => m.id === 'msg_2');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toBe('Sorry, I encountered an error. Please try again.');
      expect(assistantMsg!.error).toBe('Connection refused');
      expect(logError).toHaveBeenCalledWith('AIContext.sendMessage', expect.any(Error));
    });
  });

  // -----------------------------------------------------------------------
  // Finally invariant
  // -----------------------------------------------------------------------
  describe('finally invariant', () => {
    it('clears isStreaming and abortController after success', async () => {
      const store = setupStore();
      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().sendMessage('hello');

      const state = store.getState();
      expect(state.isStreaming).toBe(false);
      expect(state.abortController).toBeNull();
    });

    it('clears isStreaming and abortController after error', async () => {
      const store = setupStore();
      mockProcessStream.mockRejectedValueOnce(new Error('fail'));

      await store.getState().sendMessage('hello');

      const state = store.getState();
      expect(state.isStreaming).toBe(false);
      expect(state.abortController).toBeNull();
    });

    it('clears isStreaming and abortController after timeout', async () => {
      const store = setupStore();
      mockProcessStream.mockRejectedValueOnce(new Error('Stream timeout: no response received'));

      await store.getState().sendMessage('hello');

      const state = store.getState();
      expect(state.isStreaming).toBe(false);
      expect(state.abortController).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Pending payload / file attachment
  // -----------------------------------------------------------------------
  describe('pending payload', () => {
    it('appends file-attached note when user provides text with payload', async () => {
      const store = setupStore({
        pendingPayload: { filename: 'deploy.yaml', hash: 'abc', data: new Uint8Array() },
      });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult({ content: 'Deploying...' }));

      await store.getState().sendMessage('deploy this app');

      const state = store.getState();
      const userMsg = state.messages.find(m => m.role === 'user');
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe('deploy this app (File attached: deploy.yaml)');
    });

    it('generates default deploy message when no user text with payload', async () => {
      const store = setupStore({
        pendingPayload: { filename: 'stack.json', hash: 'def', data: new Uint8Array() },
      });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult({ content: 'Deploying...' }));

      await store.getState().sendMessage('');

      // Empty input + payload → effectiveContent = "Deploy this (File attached: stack.json)"
      // validateUserInput returns the trimmed string, so message should be created
      const state = store.getState();
      const userMsg = state.messages.find(m => m.role === 'user');
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe('Deploy this (File attached: stack.json)');
    });

    it('clears pendingPayload in finally block', async () => {
      const store = setupStore({
        pendingPayload: { filename: 'app.yaml', hash: 'xyz', data: new Uint8Array() },
      });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().sendMessage('deploy');

      expect(store.getState().pendingPayload).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Message sequence
  // -----------------------------------------------------------------------
  describe('message sequence', () => {
    it('creates user message then assistant message in order', async () => {
      const store = setupStore();
      mockProcessStream.mockResolvedValueOnce(makeStreamResult({ content: 'response' }));

      await store.getState().sendMessage('hello');

      const state = store.getState();
      expect(state.messages.length).toBeGreaterThanOrEqual(2);
      // msg_1 = user, msg_2 = assistant
      expect(state.messages[0].id).toBe('msg_1');
      expect(state.messages[0].role).toBe('user');
      expect(state.messages[0].content).toBe('hello');

      expect(state.messages[1].id).toBe('msg_2');
      expect(state.messages[1].role).toBe('assistant');
      expect(state.messages[1].content).toBe('response');
    });
  });
});
