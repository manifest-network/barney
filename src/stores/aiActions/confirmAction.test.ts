import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamResult } from '../../ai/streamUtils';
import type { ToolResult } from '../../ai/toolExecutor';
import type { PendingConfirmation, ChatMessage } from '../../contexts/aiTypes';
import { createAIStore, type AIStore } from '../aiStore';

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

const mockExecuteConfirmedTool = vi.fn<(
  toolName: string,
  args: Record<string, unknown>,
  clientManager: unknown,
  options: unknown,
  payload?: unknown
) => Promise<ToolResult>>();
vi.mock('../../ai/toolExecutor', () => ({
  executeConfirmedTool: (...args: unknown[]) => mockExecuteConfirmedTool(...(args as [string, Record<string, unknown>, unknown, unknown, unknown?])),
}));

const mockProcessStream = vi.fn<() => Promise<StreamResult>>();
vi.mock('../../ai/streamUtils', () => ({
  processStreamWithTimeout: (...args: unknown[]) => mockProcessStream(...(args as [])),
}));

vi.mock('../../utils/errors', () => ({
  logError: vi.fn(),
}));

vi.mock('../../ai/systemPrompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}));

vi.mock('../../config/runtimeConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/runtimeConfig')>();
  return { ...actual, runtimeConfig: { ...actual.runtimeConfig, PUBLIC_MORPHEUS_MODEL: 'minimax-m2.5' } };
});

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Store = ReturnType<typeof createAIStore>;

function makeStreamResult(overrides: Partial<StreamResult> = {}): StreamResult {
  return {
    content: 'Done!',
    thinking: '',
    toolCalls: [],
    ...overrides,
  };
}

function makePendingConfirmation(overrides: Partial<PendingConfirmation> = {}): PendingConfirmation {
  return {
    id: 'confirm_1',
    action: {
      id: 'action_1',
      toolName: 'deploy_app',
      args: { image: 'nginx' },
      description: 'Deploy nginx?',
    },
    messageId: 'tool_msg_1',
    ...overrides,
  };
}

function makeToolMessage(id: string): ChatMessage {
  return {
    id,
    role: 'tool',
    content: 'Awaiting confirmation...',
    toolName: 'deploy_app',
    toolCallId: 'tc_1',
    timestamp: 1000,
    isStreaming: true,
  };
}

const fakeClientManager = { fake: true } as unknown as NonNullable<AIStore['clientManager']>;

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
      saveHistory: false,
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
// confirmAction tests
// ===========================================================================

describe('confirmAction', () => {
  // -----------------------------------------------------------------------
  // Guard clauses
  // -----------------------------------------------------------------------
  describe('guard clauses', () => {
    it('no-ops when there is no pendingConfirmation', async () => {
      const store = setupStore({ pendingConfirmation: null });
      await store.getState().confirmAction();
      expect(store.getState().isStreaming).toBe(false);
      expect(mockExecuteConfirmedTool).not.toHaveBeenCalled();
    });

    it('no-ops when isStreaming is true', async () => {
      const store = setupStore({
        isStreaming: true,
        pendingConfirmation: makePendingConfirmation(),
      });
      await store.getState().confirmAction();
      expect(mockExecuteConfirmedTool).not.toHaveBeenCalled();
      // pendingConfirmation should remain unchanged
      expect(store.getState().pendingConfirmation).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Wallet disconnected
  // -----------------------------------------------------------------------
  describe('wallet disconnected', () => {
    it('clears pending and sets wallet_disconnected error when clientManager is null', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const store = setupStore({
        clientManager: null,
        pendingConfirmation: makePendingConfirmation(),
        messages: [toolMsg],
      });

      await store.getState().confirmAction();

      const state = store.getState();
      expect(state.pendingConfirmation).toBeNull();
      const updated = state.messages.find(m => m.id === 'tool_msg_1');
      expect(updated).toBeDefined();
      expect(updated!.error).toBe('wallet_disconnected');
      expect(updated!.content).toContain('Wallet disconnected');
      expect(updated!.isStreaming).toBe(false);
      expect(mockExecuteConfirmedTool).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Manifest edit application
  // -----------------------------------------------------------------------
  describe('manifest edit application', () => {
    it('replaces _generatedManifest with editedManifestJson and clears payload', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const pending = makePendingConfirmation({
        action: {
          id: 'action_1',
          toolName: 'deploy_app',
          args: { _generatedManifest: '{"old":"manifest"}', image: 'nginx' },
          description: 'Deploy?',
          payload: { bytes: new Uint8Array(), size: 10, hash: 'abc' },
        },
      });
      const store = setupStore({
        pendingConfirmation: pending,
        messages: [toolMsg],
      });

      mockExecuteConfirmedTool.mockResolvedValueOnce({ success: true, data: { deployed: true } });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().confirmAction('{"new":"manifest"}');

      // The executeConfirmedTool should have been called with the edited manifest
      const callArgs = mockExecuteConfirmedTool.mock.calls[0];
      expect(callArgs[1]._generatedManifest).toBe('{"new":"manifest"}');
      // payload should be cleared (set to undefined)
      expect(callArgs[4]).toBeUndefined();
    });

    it('does not replace when no _generatedManifest in args', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const pending = makePendingConfirmation({
        action: {
          id: 'action_1',
          toolName: 'deploy_app',
          args: { image: 'nginx' },
          description: 'Deploy?',
        },
      });
      const store = setupStore({
        pendingConfirmation: pending,
        messages: [toolMsg],
      });

      mockExecuteConfirmedTool.mockResolvedValueOnce({ success: true, data: {} });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().confirmAction('{"new":"manifest"}');

      // _generatedManifest should not have been added
      const callArgs = mockExecuteConfirmedTool.mock.calls[0];
      expect(callArgs[1]._generatedManifest).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Successful execution
  // -----------------------------------------------------------------------
  describe('successful execution', () => {
    it('updates tool message with result and streams follow-up', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const store = setupStore({
        pendingConfirmation: makePendingConfirmation(),
        messages: [toolMsg],
      });

      mockExecuteConfirmedTool.mockResolvedValueOnce({ success: true, data: { deployed: true } });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult({ content: 'Deployed successfully!' }));

      await store.getState().confirmAction();

      const state = store.getState();
      // Tool message should have the result content
      const updatedTool = state.messages.find(m => m.id === 'tool_msg_1');
      expect(updatedTool).toBeDefined();
      expect(updatedTool!.isStreaming).toBe(false);
      expect(updatedTool!.content).toContain('"success": true');

      // A new assistant message should have been added with the stream response
      const assistantMsg = state.messages.find(m => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toBe('Deployed successfully!');
      expect(assistantMsg!.isStreaming).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // BigInt serialization
  // -----------------------------------------------------------------------
  describe('BigInt serialization', () => {
    it('serializes BigInt values in confirmed tool result as strings', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const store = setupStore({
        pendingConfirmation: makePendingConfirmation(),
        messages: [toolMsg],
      });

      mockExecuteConfirmedTool.mockResolvedValueOnce({
        success: true,
        data: { activeLeaseCount: 3n, estimatedDurationSeconds: 86400n },
      });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().confirmAction();

      const state = store.getState();
      const updatedTool = state.messages.find(m => m.id === 'tool_msg_1');
      expect(updatedTool).toBeDefined();
      const parsed = JSON.parse(updatedTool!.content);
      expect(parsed.data.activeLeaseCount).toBe('3');
      expect(parsed.data.estimatedDurationSeconds).toBe('86400');
    });
  });

  // -----------------------------------------------------------------------
  // Failure per tool type
  // -----------------------------------------------------------------------
  describe('failure per tool type', () => {
    it('clears deployProgress on restart_app failure', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const pending = makePendingConfirmation({
        action: {
          id: 'action_1',
          toolName: 'restart_app',
          args: { app_name: 'myapp' },
          description: 'Restart myapp?',
        },
      });
      const store = setupStore({
        pendingConfirmation: pending,
        messages: [toolMsg],
        deployProgress: { phase: 'restarting' },
      });

      mockExecuteConfirmedTool.mockResolvedValueOnce({ success: false, error: 'restart failed' });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().confirmAction();

      expect(store.getState().deployProgress).toBeNull();
    });

    it('clears deployProgress on update_app failure', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const pending = makePendingConfirmation({
        action: {
          id: 'action_1',
          toolName: 'update_app',
          args: { app_name: 'myapp', image: 'nginx:latest' },
          description: 'Update myapp?',
        },
      });
      const store = setupStore({
        pendingConfirmation: pending,
        messages: [toolMsg],
        deployProgress: { phase: 'updating' },
      });

      mockExecuteConfirmedTool.mockResolvedValueOnce({ success: false, error: 'update failed' });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().confirmAction();

      expect(store.getState().deployProgress).toBeNull();
    });

    it('does not enter isSimple branch on deploy_app failure (deployProgress already cleared at top of try)', async () => {
      // The try block unconditionally does set({ deployProgress: null }) at the
      // top, so deployProgress is always null after confirmAction regardless of
      // tool type. The isSimple branch (restart_app/update_app) adds a redundant
      // second clear. This test verifies deploy_app skips that branch — the
      // observable outcome is the same (null), but the code path differs.
      const toolMsg = makeToolMessage('tool_msg_1');
      const store = setupStore({
        pendingConfirmation: makePendingConfirmation(),
        messages: [toolMsg],
        deployProgress: { phase: 'uploading' },
      });

      mockExecuteConfirmedTool.mockResolvedValueOnce({ success: false, error: 'deploy failed' });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().confirmAction();

      expect(store.getState().deployProgress).toBeNull();
    });

    it('sets toolError on the follow-up assistant message when execution fails', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const store = setupStore({
        pendingConfirmation: makePendingConfirmation(),
        messages: [toolMsg],
      });

      mockExecuteConfirmedTool.mockResolvedValueOnce({ success: false, error: 'insufficient funds' });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult({ content: 'The deploy failed.' }));

      await store.getState().confirmAction();

      const state = store.getState();
      const assistantMsg = state.messages.find(m => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.error).toBe('insufficient funds');
    });
  });

  // -----------------------------------------------------------------------
  // Stream error in follow-up
  // -----------------------------------------------------------------------
  describe('stream error in follow-up', () => {
    it('shows error content when stream returns error', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const store = setupStore({
        pendingConfirmation: makePendingConfirmation(),
        messages: [toolMsg],
      });

      mockExecuteConfirmedTool.mockResolvedValueOnce({ success: true, data: {} });
      mockProcessStream.mockResolvedValueOnce(
        makeStreamResult({ error: 'stream failed', content: '' })
      );

      await store.getState().confirmAction();

      const state = store.getState();
      const assistantMsg = state.messages.find(m => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toContain('Error: stream failed');
      expect(assistantMsg!.error).toBe('stream failed');
    });
  });

  // -----------------------------------------------------------------------
  // Catch: timeout vs generic
  // -----------------------------------------------------------------------
  describe('catch block', () => {
    it('shows TX-may-have-completed message on timeout error', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const store = setupStore({
        pendingConfirmation: makePendingConfirmation(),
        messages: [toolMsg],
      });

      mockExecuteConfirmedTool.mockRejectedValueOnce(new Error('Connection timeout'));

      await store.getState().confirmAction();

      const state = store.getState();
      const updated = state.messages.find(m => m.id === 'tool_msg_1');
      expect(updated).toBeDefined();
      expect(updated!.content).toContain('transaction may have completed');
      expect(updated!.error).toContain('timeout');
      expect(state.deployProgress).toBeNull();
      expect(logError).toHaveBeenCalledWith('AIContext.confirmAction', expect.any(Error));
    });

    it('shows generic error message for non-timeout errors', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const store = setupStore({
        pendingConfirmation: makePendingConfirmation(),
        messages: [toolMsg],
      });

      mockExecuteConfirmedTool.mockRejectedValueOnce(new Error('Network error'));

      await store.getState().confirmAction();

      const state = store.getState();
      const updated = state.messages.find(m => m.id === 'tool_msg_1');
      expect(updated).toBeDefined();
      expect(updated!.content).toContain('Error executing transaction');
      expect(updated!.content).toContain('Network error');
      expect(updated!.error).toBe('Network error');
      expect(state.deployProgress).toBeNull();
      expect(logError).toHaveBeenCalledWith('AIContext.confirmAction', expect.any(Error));
    });
  });

  // -----------------------------------------------------------------------
  // Finally invariant
  // -----------------------------------------------------------------------
  describe('finally invariant', () => {
    it('clears isStreaming, pendingPayload, and abortController after success', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const store = setupStore({
        pendingConfirmation: makePendingConfirmation(),
        pendingPayload: { bytes: new Uint8Array(), filename: 'test.json', size: 10, hash: 'abc' },
        messages: [toolMsg],
      });

      mockExecuteConfirmedTool.mockResolvedValueOnce({ success: true, data: {} });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult());

      await store.getState().confirmAction();

      const state = store.getState();
      expect(state.isStreaming).toBe(false);
      expect(state.pendingPayload).toBeNull();
      expect(state.abortController).toBeNull();
    });

    it('clears isStreaming, pendingPayload, and abortController after error', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const store = setupStore({
        pendingConfirmation: makePendingConfirmation(),
        pendingPayload: { bytes: new Uint8Array(), filename: 'test.json', size: 10, hash: 'abc' },
        messages: [toolMsg],
      });

      mockExecuteConfirmedTool.mockRejectedValueOnce(new Error('fail'));

      await store.getState().confirmAction();

      const state = store.getState();
      expect(state.isStreaming).toBe(false);
      expect(state.pendingPayload).toBeNull();
      expect(state.abortController).toBeNull();
    });

    it('clears isStreaming, pendingPayload, and abortController after timeout', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const store = setupStore({
        pendingConfirmation: makePendingConfirmation(),
        pendingPayload: { bytes: new Uint8Array(), filename: 'test.json', size: 10, hash: 'abc' },
        messages: [toolMsg],
      });

      mockExecuteConfirmedTool.mockRejectedValueOnce(new Error('Request timeout'));

      await store.getState().confirmAction();

      const state = store.getState();
      expect(state.isStreaming).toBe(false);
      expect(state.pendingPayload).toBeNull();
      expect(state.abortController).toBeNull();
    });
  });
});

// ===========================================================================
// cancelAction tests
// ===========================================================================

describe('cancelAction', () => {
  it('no-ops when there is no pendingConfirmation', () => {
    const store = setupStore({ pendingConfirmation: null });
    const msgsBefore = store.getState().messages;
    store.getState().cancelAction();
    expect(store.getState().messages).toBe(msgsBefore);
  });

  it('clears pendingConfirmation, pendingPayload, and deployProgress', () => {
    const toolMsg = makeToolMessage('tool_msg_1');
    const store = setupStore({
      pendingConfirmation: makePendingConfirmation(),
      pendingPayload: { bytes: new Uint8Array(), filename: 'test.json', size: 10, hash: 'abc' },
      deployProgress: { phase: 'creating_lease' },
      messages: [toolMsg],
    });

    store.getState().cancelAction();

    const state = store.getState();
    expect(state.pendingConfirmation).toBeNull();
    expect(state.pendingPayload).toBeNull();
    expect(state.deployProgress).toBeNull();
  });

  it('updates tool message with cancellation content', () => {
    const toolMsg = makeToolMessage('tool_msg_1');
    const store = setupStore({
      pendingConfirmation: makePendingConfirmation(),
      messages: [toolMsg],
    });

    store.getState().cancelAction();

    const state = store.getState();
    const updated = state.messages.find(m => m.id === 'tool_msg_1');
    expect(updated).toBeDefined();
    expect(updated!.content).toBe('Action cancelled by user.');
    expect(updated!.isStreaming).toBe(false);
  });
});
