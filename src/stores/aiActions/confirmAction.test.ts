import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { StreamResult } from '../../ai/streamUtils';
import type { PendingAction, ToolResult } from '../../ai/toolExecutor';
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
  options: unknown,
  payload?: unknown
) => Promise<ToolResult>>();
vi.mock('../../ai/toolExecutor', () => ({
  executeConfirmedTool: (...args: unknown[]) => mockExecuteConfirmedTool(...(args as [string, Record<string, unknown>, unknown, unknown?])),
}));

const mockExecuteBatchDeploy = vi.fn<() => Promise<ToolResult>>();
const mockBuildPayloadFromManifest = vi.fn(async (manifest: string) => {
  const bytes = new TextEncoder().encode(manifest);
  return { bytes, filename: 'manifest.json', size: bytes.length, hash: 'new-hash' };
});
vi.mock('../../ai/toolExecutor/compositeTransactions', () => ({
  executeBatchDeploy: (...args: unknown[]) => mockExecuteBatchDeploy(...(args as [])),
  buildPayloadFromManifest: (...args: unknown[]) => mockBuildPayloadFromManifest(...(args as [string])),
  deriveAppName: vi.fn((filename: string) => filename.replace(/\.[^.]+$/, '')),
}));

const mockProcessStream = vi.fn<() => Promise<StreamResult>>();
vi.mock('../../ai/streamUtils', () => ({
  processStreamWithTimeout: (...args: unknown[]) => mockProcessStream(...(args as [])),
}));

vi.mock('../../utils/errors', () => ({
  logError: vi.fn(),
}));

vi.mock('../../contexts/aiStoreContext', () => ({
  useAIStore: (selector: (state: {
    sendMessage: () => Promise<void>;
    retrySkuTiers: () => Promise<void>;
  }) => unknown) => selector({
    sendMessage: vi.fn(() => Promise.resolve()),
    retrySkuTiers: vi.fn(() => Promise.resolve()),
  }),
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
import { MessageBubble } from '../../components/ai/MessageBubble';

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

function makePendingConfirmation(
  overrides: Omit<Partial<PendingConfirmation>, 'action'> & { action?: Partial<PendingAction> } = {},
): PendingConfirmation {
  const { action: actionOverrides, ...confirmationOverrides } = overrides;
  const action = {
    originAddress: 'manifest1test',
    chainId: 'manifest-test',
    clientGeneration: 0,
    signerGeneration: 0,
    id: 'action_1',
    toolName: 'deploy_app',
    args: { image: 'nginx' },
    description: 'Deploy nginx?',
    ...actionOverrides,
  };
  return {
    id: 'confirm_1',
    messageId: 'tool_msg_1',
    ...confirmationOverrides,
    action,
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
    isStreaming: false,
    awaitingConfirmation: true,
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
    chainId: 'manifest-test',
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

    it.each([
      ['originAddress', 'manifest1other'],
      ['chainId', 'other-chain'],
      ['clientGeneration', 1],
      ['signerGeneration', 1],
    ] as const)('fails closed when bound %s no longer matches', async (field, value) => {
      const pending = makePendingConfirmation({ action: { [field]: value } });
      const store = setupStore({
        pendingConfirmation: pending,
        messages: [makeToolMessage(pending.messageId)],
      });

      await store.getState().confirmAction();

      expect(mockExecuteConfirmedTool).not.toHaveBeenCalled();
      expect(store.getState().pendingConfirmation).toBeNull();
      expect(store.getState().messages[0].content).toContain('cancelled and was not submitted');
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

      await store.getState().confirmAction({ editedManifestJson: '{"new":"manifest"}' });

      // The executeConfirmedTool should have been called with the edited manifest
      const callArgs = mockExecuteConfirmedTool.mock.calls[0];
      expect(callArgs[1]._generatedManifest).toBe('{"new":"manifest"}');
      // payload should be cleared (set to undefined)
      expect(callArgs[3]).toBeUndefined();
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

      await store.getState().confirmAction({ editedManifestJson: '{"new":"manifest"}' });

      // _generatedManifest should not have been added
      const callArgs = mockExecuteConfirmedTool.mock.calls[0];
      expect(callArgs[1]._generatedManifest).toBeUndefined();
    });
  });

  describe('batch edit re-planning', () => {
    it('creates a new confirmation plan and never broadcasts edited entries directly', async () => {
      const pending = makePendingConfirmation({
        action: {
          toolName: 'batch_deploy',
          args: { plan: { version: 1, planHash: 'old-plan' } },
          description: 'Deploy 2 apps for 0.2000 PWR/hr total?',
        },
      });
      const store = setupStore({
        pendingConfirmation: pending,
        messages: [makeToolMessage(pending.messageId)],
      });
      const newPlan = {
        version: 1,
        entries: [{ draftIndex: 0, app_name: 'alpha', manifest: '{"image":"alpha:v2"}' }],
        totalServiceCount: 1,
        totalPricePerHour: 0.1,
        denomSymbol: 'PWR',
        planHash: 'new-plan',
      };
      mockExecuteBatchDeploy.mockResolvedValueOnce({
        success: true,
        requiresConfirmation: true,
        confirmationMessage: 'Deploy 1 app (alpha) for 0.1000 PWR/hr total?',
        pendingAction: { toolName: 'batch_deploy', args: { plan: newPlan } },
      });

      await store.getState().confirmAction({
        editedBatchEntries: [{
          draftIndex: 0,
          app_name: 'alpha',
          size: 'docker-micro',
          manifest: '{"image":"alpha:v2"}',
          manifestFilename: 'alpha.json',
        }],
      });

      expect(mockBuildPayloadFromManifest).toHaveBeenCalledWith('{"image":"alpha:v2"}');
      expect(mockExecuteBatchDeploy).toHaveBeenCalledWith(
        [expect.objectContaining({
          app_name: 'alpha',
          size: 'docker-micro',
          payload: expect.objectContaining({ filename: 'alpha.json' }),
        })],
        expect.objectContaining({ address: 'manifest1test' }),
      );
      expect(mockExecuteConfirmedTool).not.toHaveBeenCalled();
      expect(store.getState().pendingConfirmation?.action.args.plan).toBe(newPlan);
      expect(store.getState().pendingConfirmation?.id).not.toBe(pending.id);
      expect(store.getState().messages[0].content).toContain('0.1000 PWR/hr total');
      expect(store.getState().isStreaming).toBe(false);
    });

    it('keeps the edited confirmation mounted and retryable when re-planning fails', async () => {
      const pending = makePendingConfirmation({
        action: {
          toolName: 'batch_deploy',
          args: { plan: { version: 1, planHash: 'old-plan' } },
          description: 'Deploy 2 apps for 0.2000 PWR/hr total?',
        },
      });
      const store = setupStore({
        pendingConfirmation: pending,
        messages: [makeToolMessage(pending.messageId)],
      });
      mockExecuteBatchDeploy.mockResolvedValueOnce({
        success: false,
        error: 'Tier catalog unavailable — try again in a moment.',
      });

      await store.getState().confirmAction({
        editedBatchEntries: [{
          draftIndex: 0,
          app_name: 'alpha',
          size: 'docker-micro',
          manifest: '{"image":"alpha:v2"}',
          manifestFilename: 'alpha.json',
        }],
      });

      const state = store.getState();
      expect(state.pendingConfirmation?.id).toBe(pending.id);
      expect(state.pendingConfirmation?.action.args.plan).toBe(pending.action.args.plan);
      expect(state.pendingConfirmation?.action.args._batchReplanError).toContain('Tier catalog unavailable');
      expect(state.messages[0]).toMatchObject({
        content: pending.action.description,
        error: expect.stringContaining('Tier catalog unavailable'),
        awaitingConfirmation: true,
        isStreaming: false,
      });
      expect(state.abortController).toBeNull();
      expect(state.isStreaming).toBe(false);
      expect(mockExecuteConfirmedTool).not.toHaveBeenCalled();
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

    it('resolves an in-flight tool row when the wallet changes', async () => {
      let finishTransaction!: (result: ToolResult) => void;
      mockExecuteConfirmedTool.mockImplementationOnce(() => new Promise((resolve) => {
        finishTransaction = resolve;
      }));

      const pending = makePendingConfirmation();
      const store = setupStore({
        pendingConfirmation: pending,
        messages: [makeToolMessage(pending.messageId)],
      });

      const confirming = store.getState().confirmAction();
      expect(mockExecuteConfirmedTool).toHaveBeenCalledOnce();
      expect(store.getState().activeTransactionMessageId).toBe(pending.messageId);
      expect(store.getState().messages[0]).toMatchObject({
        isStreaming: false,
        awaitingConfirmation: false,
        transactionInFlight: true,
      });

      const nextManager = { fake: 'next' } as unknown as NonNullable<AIStore['clientManager']>;
      store.getState().setWalletContext({
        clientManager: nextManager,
        address: 'manifest1next',
        signing: undefined,
        chainId: 'manifest-test',
      });

      let tool = store.getState().messages.find((message) => message.id === pending.messageId);
      expect(tool).toMatchObject({
        isStreaming: false,
        awaitingConfirmation: false,
        transactionInFlight: false,
        error: expect.stringContaining('may already have been submitted'),
      });

      finishTransaction({
        success: true,
        data: { message: 'Deployment completed for the previous wallet.' },
      });
      await confirming;

      tool = store.getState().messages.find((message) => message.id === pending.messageId);
      expect(tool?.content).toContain('"success": true');
      expect(tool?.content).toContain('"authorizationNotice"');
      expect(tool?.content).toContain('previous wallet');
      expect(tool?.error).toBeUndefined();
      expect(tool?.transactionInFlight).toBe(false);
      expect(tool?.isStreaming).toBe(false);
      const notice = store.getState().messages.find((message) =>
        message.role === 'assistant' && message.local === true
      );
      expect(notice).toMatchObject({
        content: expect.stringContaining('previous wallet'),
      });
      expect(notice?.error).toBeUndefined();
      expect(notice?.content).toContain('Deployment completed for the previous wallet.');

      // Render the exact message produced by confirmAction through the real UI
      // component. This pins the production path and its neutral presentation
      // together rather than hand-constructing a lookalike message.
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        flushSync(() => {
          root.render(createElement(MessageBubble, { message: notice! }));
        });
        expect(container.querySelector('.message-text')?.textContent)
          .toContain('finished for the previous wallet');
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(Array.from(container.querySelectorAll('button')).some(
          (button) => button.textContent?.trim() === 'Check credits'
        )).toBe(false);
      } finally {
        flushSync(() => root.unmount());
        container.remove();
      }

      expect(store.getState().address).toBe('manifest1next');
      expect(store.getState().activeTransactionMessageId).toBeNull();
      expect(mockProcessStream).not.toHaveBeenCalled();
    });

    it('surfaces a successful partial summary when Stop aborts the follow-up', async () => {
      let finishTransaction!: (result: ToolResult) => void;
      mockExecuteConfirmedTool.mockImplementationOnce(() => new Promise((resolve) => {
        finishTransaction = resolve;
      }));
      const pending = makePendingConfirmation({
        action: { toolName: 'stop_app', args: { app_name: 'all', entries: [] } },
      });
      const store = setupStore({
        pendingConfirmation: pending,
        messages: [makeToolMessage(pending.messageId)],
      });

      const confirming = store.getState().confirmAction();
      store.getState().stopStreaming();
      finishTransaction({
        success: true,
        data: {
          message: 'Stopped: a. Submission uncertain: b; check on-chain status before retrying. Not submitted: c.',
        },
      });
      await confirming;

      const assistant = store.getState().messages.find((message) => message.role === 'assistant');
      expect(assistant).toMatchObject({
        local: true,
        content: expect.stringContaining('Submission uncertain: b'),
      });
      expect(mockProcessStream).not.toHaveBeenCalled();
    });

    it('does not misclassify an ordinary Stop as a wallet authorization change', async () => {
      let finishTransaction!: (result: ToolResult) => void;
      mockExecuteConfirmedTool.mockImplementationOnce(() => new Promise((resolve) => {
        finishTransaction = resolve;
      }));

      const pending = makePendingConfirmation();
      const store = setupStore({
        pendingConfirmation: pending,
        messages: [makeToolMessage(pending.messageId)],
      });

      const confirming = store.getState().confirmAction();
      const executorOptions = mockExecuteConfirmedTool.mock.calls[0][2] as {
        assertAuthorization: () => void;
      };

      store.getState().stopStreaming();
      expect(executorOptions.assertAuthorization).not.toThrow();

      finishTransaction({
        success: false,
        error: 'Transaction was cancelled before broadcast; no transaction was sent.',
      });
      await confirming;

      const tool = store.getState().messages.find((message) => message.id === pending.messageId);
      expect(tool?.error).toContain('cancelled before broadcast');
      expect(tool?.error).not.toContain('Wallet or network changed');
      expect(mockProcessStream).not.toHaveBeenCalled();
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

    it('renders a failed confirmed transaction error only on the tool row', async () => {
      const toolMsg = makeToolMessage('tool_msg_1');
      const store = setupStore({
        pendingConfirmation: makePendingConfirmation(),
        messages: [toolMsg],
      });

      mockExecuteConfirmedTool.mockResolvedValueOnce({ success: false, error: 'insufficient funds' });
      mockProcessStream.mockResolvedValueOnce(makeStreamResult({ content: 'The deploy failed.' }));

      await store.getState().confirmAction();

      const state = store.getState();
      const updatedTool = state.messages.find(m => m.id === 'tool_msg_1');
      const assistantMsg = state.messages.find(m => m.role === 'assistant');
      expect(updatedTool?.error).toBe('insufficient funds');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.error).toBeUndefined();
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

    it('does not rewrite a completed transaction when the follow-up stream throws', async () => {
      const pending = makePendingConfirmation();
      const store = setupStore({
        pendingConfirmation: pending,
        messages: [makeToolMessage(pending.messageId)],
      });
      mockExecuteConfirmedTool.mockResolvedValueOnce({
        success: true,
        data: { message: 'Deployed.' },
      });
      mockProcessStream.mockRejectedValueOnce(new Error('relay disconnected'));

      await store.getState().confirmAction();

      const tool = store.getState().messages.find((message) => message.id === pending.messageId);
      expect(tool?.content).toContain('"success": true');
      expect(tool?.error).toBeUndefined();
      const assistant = store.getState().messages.find((message) => message.role === 'assistant');
      expect(assistant).toMatchObject({
        content: expect.stringContaining('transaction result is shown above'),
        error: 'relay disconnected',
        isStreaming: false,
      });
      expect(logError).toHaveBeenCalledWith('AIContext.confirmAction.followUp', expect.any(Error));
    });

    it('does not claim a failed transaction completed when its follow-up throws', async () => {
      const pending = makePendingConfirmation();
      const store = setupStore({
        pendingConfirmation: pending,
        messages: [makeToolMessage(pending.messageId)],
      });
      mockExecuteConfirmedTool.mockResolvedValueOnce({ success: false, error: 'insufficient funds' });
      mockProcessStream.mockRejectedValueOnce(new Error('relay disconnected'));

      await store.getState().confirmAction();

      const assistant = store.getState().messages.find((message) => message.role === 'assistant');
      expect(assistant?.content).toContain('transaction result is shown above');
      expect(assistant?.content).not.toContain('transaction completed');
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
    it('does not let a stale catch/finally clobber the next wallet work', async () => {
      let rejectTransaction!: (error: Error) => void;
      mockExecuteConfirmedTool.mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectTransaction = reject;
      }));
      const pending = makePendingConfirmation();
      const store = setupStore({
        pendingConfirmation: pending,
        messages: [makeToolMessage(pending.messageId)],
      });

      const confirming = store.getState().confirmAction();
      store.getState().setWalletContext({
        clientManager: { fake: 'next' } as unknown as NonNullable<AIStore['clientManager']>,
        address: 'manifest1next',
        signing: undefined,
        chainId: 'manifest-test',
      });
      const nextAbort = new AbortController();
      store.setState({
        isStreaming: true,
        abortController: nextAbort,
        activeTransactionMessageId: 'next-wallet-tool',
      });

      rejectTransaction(new Error('old wallet executor failed'));
      await confirming;

      expect(store.getState()).toMatchObject({
        address: 'manifest1next',
        isStreaming: true,
        abortController: nextAbort,
        activeTransactionMessageId: 'next-wallet-tool',
      });
      expect(nextAbort.signal.aborted).toBe(false);
      expect(store.getState().messages[0]).toMatchObject({
        transactionInFlight: false,
        error: 'old wallet executor failed',
      });
    });

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
    const toolMsg = {
      ...makeToolMessage('tool_msg_1'),
      error: 'Tier catalog unavailable',
    };
    const store = setupStore({
      pendingConfirmation: makePendingConfirmation(),
      messages: [toolMsg],
    });

    store.getState().cancelAction();

    const state = store.getState();
    const updated = state.messages.find(m => m.id === 'tool_msg_1');
    expect(updated).toBeDefined();
    expect(updated!.content).toBe('Action cancelled by user.');
    expect(updated!.error).toBeUndefined();
    expect(updated!.isStreaming).toBe(false);
    expect(updated!.awaitingConfirmation).toBe(false);
  });
});
