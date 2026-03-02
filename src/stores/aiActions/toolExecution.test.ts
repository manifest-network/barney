import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCall } from '../../api/morpheus';
import type { AIStore } from '../aiStore';
import type { ChatMessage } from '../../contexts/aiTypes';
import type { ToolResult } from '../../ai/toolExecutor';

// --- Mocks ---

vi.mock('../../ai/tools', () => ({
  isValidToolName: vi.fn().mockReturnValue(true),
  getToolCallDescription: vi.fn().mockReturnValue('Executing tool...'),
}));

vi.mock('../../ai/toolExecutor', () => ({
  executeTool: vi.fn().mockResolvedValue({ success: true, data: { result: 'ok' } }),
}));

vi.mock('../../ai/toolExecutor/compositeTransactions', () => ({
  buildPayloadFromManifest: vi.fn().mockResolvedValue({
    bytes: new Uint8Array([123, 125]),
    filename: 'manifest.json',
    size: 2,
    hash: 'abc123',
  }),
}));

vi.mock('../../ai/validation', () => ({
  sanitizeToolArgs: vi.fn((args: unknown) => args),
}));

vi.mock('../../utils/errors', () => ({
  logError: vi.fn(),
}));

vi.mock('../../ai/systemPrompt', () => ({
  getSystemPrompt: vi.fn().mockReturnValue('system prompt'),
}));

vi.mock('../../registry/appRegistry', () => ({
  getApps: vi.fn().mockReturnValue([]),
  getApp: vi.fn().mockReturnValue(null),
  findApp: vi.fn().mockReturnValue(null),
  getAppByLease: vi.fn().mockReturnValue(null),
  addApp: vi.fn(),
  updateApp: vi.fn(),
  validateAppName: vi.fn().mockReturnValue(null),
}));

import { processToolCallsFn } from './toolExecution';
import { isValidToolName } from '../../ai/tools';
import { executeTool } from '../../ai/toolExecutor';
import { buildPayloadFromManifest } from '../../ai/toolExecutor/compositeTransactions';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc_1',
    type: 'function',
    function: {
      name: 'list_apps',
      arguments: {},
    },
    ...overrides,
  };
}

describe('processToolCallsFn', () => {
  let state: {
    messages: ChatMessage[];
    pendingConfirmation: AIStore['pendingConfirmation'];
    pendingPayload: AIStore['pendingPayload'];
    deployProgress: AIStore['deployProgress'];
    clientManager: AIStore['clientManager'];
    address: AIStore['address'];
    signArbitrary: AIStore['signArbitrary'];
    abortController: AIStore['abortController'];
    _toolCache: Map<string, { result: ToolResult; timestamp: number }>;
  };
  let get: () => AIStore;
  let set: (partial: Partial<AIStore> | ((state: AIStore) => Partial<AIStore>)) => void;

  beforeEach(() => {
    vi.clearAllMocks();

    state = {
      messages: [],
      pendingConfirmation: null,
      pendingPayload: null,
      deployProgress: null,
      clientManager: null,
      address: 'manifest1test',
      signArbitrary: undefined,
      abortController: null,
      _toolCache: new Map(),
    };

    get = () => ({
      ...state,
      getToolCacheKey: (name: string, args: Record<string, unknown>) =>
        `${state.address}:${name}:${JSON.stringify(args)}`,
      getCachedToolResult: (key: string) => {
        const cached = state._toolCache.get(key);
        if (!cached) return null;
        return cached.result;
      },
      cacheToolResult: (key: string, result: ToolResult) => {
        state._toolCache.set(key, { result, timestamp: Date.now() });
      },
    }) as unknown as AIStore;

    set = (partial) => {
      if (typeof partial === 'function') {
        const updates = partial(get());
        Object.assign(state, updates);
      } else {
        Object.assign(state, partial);
      }
    };
  });

  it('processes a single tool call and adds tool message', async () => {
    const assistantMsg = makeMessage({ id: 'asst_1', content: '', isStreaming: true });
    state.messages = [assistantMsg];
    const toolCall = makeToolCall();

    const result = await processToolCallsFn(get, set, [toolCall], 'asst_1', {
      content: 'Let me check that.',
      thinking: '',
      toolCalls: [toolCall],
    });

    expect(result.shouldContinue).toBe(true);
    // Should have: updated assistant, tool message, new assistant message
    expect(state.messages.length).toBeGreaterThanOrEqual(3);
    // Assistant message content should be updated
    expect(state.messages[0].content).toBe('Let me check that.');
    // A tool message should be present
    const toolMsg = state.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.isStreaming).toBe(false);
  });

  it('returns cached result without executing', async () => {
    const cachedResult: ToolResult = { success: true, data: { cached: true } };
    const toolCall = makeToolCall({ function: { name: 'list_apps', arguments: {} } });
    const cacheKey = `manifest1test:list_apps:${JSON.stringify({})}`;
    state._toolCache.set(cacheKey, { result: cachedResult, timestamp: Date.now() });

    const assistantMsg = makeMessage({ id: 'asst_1' });
    state.messages = [assistantMsg];

    await processToolCallsFn(get, set, [toolCall], 'asst_1', {
      content: '',
      thinking: '',
      toolCalls: [toolCall],
    });

    // executeTool should NOT have been called (cache hit)
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('sets pendingConfirmation and stops on requiresConfirmation', async () => {
    vi.mocked(executeTool).mockResolvedValueOnce({
      success: true,
      requiresConfirmation: true,
      confirmationMessage: 'Deploy this app?',
      pendingAction: { toolName: 'deploy_app', args: { image: 'nginx' } },
    });

    const assistantMsg = makeMessage({ id: 'asst_1' });
    state.messages = [assistantMsg];
    const toolCall = makeToolCall({ function: { name: 'deploy_app', arguments: { image: 'nginx' } } });

    const result = await processToolCallsFn(get, set, [toolCall], 'asst_1', {
      content: '',
      thinking: '',
      toolCalls: [toolCall],
    });

    expect(result.shouldContinue).toBe(false);
    expect(state.pendingConfirmation).not.toBeNull();
    expect(state.pendingConfirmation!.action.toolName).toBe('deploy_app');
  });

  it('sets card on message and stops for displayCard result', async () => {
    vi.mocked(executeTool).mockResolvedValueOnce({
      success: true,
      data: { apps: [] },
      displayCard: { type: 'logs', data: { app_name: 'test', logs: {}, truncated: false } },
    });

    const assistantMsg = makeMessage({ id: 'asst_1' });
    state.messages = [assistantMsg];
    const toolCall = makeToolCall();

    const result = await processToolCallsFn(get, set, [toolCall], 'asst_1', {
      content: '',
      thinking: '',
      toolCalls: [toolCall],
    });

    expect(result.shouldContinue).toBe(false);
    const toolMsg = state.messages.find(m => m.role === 'tool');
    expect(toolMsg!.card).toEqual({ type: 'logs', data: { app_name: 'test', logs: {}, truncated: false } });
  });

  it('sets error content on tool message for failed result', async () => {
    vi.mocked(executeTool).mockResolvedValueOnce({
      success: false,
      error: 'Wallet not connected',
    });

    const assistantMsg = makeMessage({ id: 'asst_1' });
    state.messages = [assistantMsg];
    const toolCall = makeToolCall();

    const result = await processToolCallsFn(get, set, [toolCall], 'asst_1', {
      content: '',
      thinking: '',
      toolCalls: [toolCall],
    });

    expect(result.shouldContinue).toBe(true);
    const toolMsg = state.messages.find(m => m.role === 'tool');
    expect(toolMsg!.content).toContain('Error: Wallet not connected');
    expect(toolMsg!.error).toBe('Wallet not connected');
  });

  it('processes all tool calls even when first requires confirmation', async () => {
    vi.mocked(executeTool)
      .mockResolvedValueOnce({
        success: true,
        requiresConfirmation: true,
        confirmationMessage: 'Confirm deploy?',
        pendingAction: { toolName: 'deploy_app', args: {} },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { apps: [] },
      });

    const assistantMsg = makeMessage({ id: 'asst_1' });
    state.messages = [assistantMsg];
    const tc1 = makeToolCall({ id: 'tc_1', function: { name: 'deploy_app', arguments: {} } });
    const tc2 = makeToolCall({ id: 'tc_2', function: { name: 'list_apps', arguments: {} } });

    const result = await processToolCallsFn(get, set, [tc1, tc2], 'asst_1', {
      content: '',
      thinking: '',
      toolCalls: [tc1, tc2],
    });

    expect(result.shouldContinue).toBe(false);
    // Both tool calls should have been executed
    expect(executeTool).toHaveBeenCalledTimes(2);
    // Single deploy → single pendingConfirmation (not batch)
    expect(state.pendingConfirmation).not.toBeNull();
    expect(state.pendingConfirmation!.action.toolName).toBe('deploy_app');
  });

  it('returns error for invalid tool name', async () => {
    vi.mocked(isValidToolName).mockReturnValueOnce(false);

    const assistantMsg = makeMessage({ id: 'asst_1' });
    state.messages = [assistantMsg];
    const toolCall = makeToolCall({ function: { name: 'fake_tool', arguments: {} } });

    const result = await processToolCallsFn(get, set, [toolCall], 'asst_1', {
      content: '',
      thinking: '',
      toolCalls: [toolCall],
    });

    expect(result.shouldContinue).toBe(true);
    const toolMsg = state.messages.find(m => m.role === 'tool');
    expect(toolMsg!.content).toContain('Unknown tool: fake_tool');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('merges multiple deploy_app confirmations into batch_deploy', async () => {
    const makeDeployResult = (appName: string): ToolResult => ({
      success: true,
      requiresConfirmation: true,
      confirmationMessage: `Deploy ${appName}?`,
      pendingAction: {
        toolName: 'deploy_app',
        args: {
          app_name: appName,
          size: 'micro',
          skuUuid: 'sku-123',
          providerUuid: 'prov-456',
          providerUrl: 'https://provider.test',
          _generatedManifest: `{"services":{"${appName}":{}}}`,
        },
      },
    });

    vi.mocked(executeTool)
      .mockResolvedValueOnce(makeDeployResult('tetris'))
      .mockResolvedValueOnce(makeDeployResult('doom'))
      .mockResolvedValueOnce(makeDeployResult('hextris'));

    const assistantMsg = makeMessage({ id: 'asst_1' });
    state.messages = [assistantMsg];

    const tc1 = makeToolCall({ id: 'tc_1', function: { name: 'deploy_app', arguments: { image: 'tetris' } } });
    const tc2 = makeToolCall({ id: 'tc_2', function: { name: 'deploy_app', arguments: { image: 'doom' } } });
    const tc3 = makeToolCall({ id: 'tc_3', function: { name: 'deploy_app', arguments: { image: 'hextris' } } });

    const result = await processToolCallsFn(get, set, [tc1, tc2, tc3], 'asst_1', {
      content: '',
      thinking: '',
      toolCalls: [tc1, tc2, tc3],
    });

    expect(result.shouldContinue).toBe(false);
    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(state.pendingConfirmation).not.toBeNull();
    expect(state.pendingConfirmation!.action.toolName).toBe('batch_deploy');

    const entries = state.pendingConfirmation!.action.args.entries as Array<{ app_name: string }>;
    expect(entries).toHaveLength(3);
    expect(entries.map(e => e.app_name)).toEqual(['tetris', 'doom', 'hextris']);
    expect(buildPayloadFromManifest).toHaveBeenCalledTimes(3);
  });

  it('excludes failed entries from batch but still batches the rest', async () => {
    const makeDeployResult = (appName: string): ToolResult => ({
      success: true,
      requiresConfirmation: true,
      confirmationMessage: `Deploy ${appName}?`,
      pendingAction: {
        toolName: 'deploy_app',
        args: {
          app_name: appName,
          size: 'micro',
          skuUuid: 'sku-123',
          providerUuid: 'prov-456',
          providerUrl: 'https://provider.test',
          _generatedManifest: `{"services":{"${appName}":{}}}`,
        },
      },
    });

    // Middle entry will fail payload build
    vi.mocked(buildPayloadFromManifest)
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]), filename: 'manifest.json', size: 1, hash: 'a' })
      .mockRejectedValueOnce(new Error('Hash computation failed'))
      .mockResolvedValueOnce({ bytes: new Uint8Array([3]), filename: 'manifest.json', size: 1, hash: 'c' });

    vi.mocked(executeTool)
      .mockResolvedValueOnce(makeDeployResult('tetris'))
      .mockResolvedValueOnce(makeDeployResult('doom'))
      .mockResolvedValueOnce(makeDeployResult('hextris'));

    const assistantMsg = makeMessage({ id: 'asst_1' });
    state.messages = [assistantMsg];

    const tc1 = makeToolCall({ id: 'tc_1', function: { name: 'deploy_app', arguments: {} } });
    const tc2 = makeToolCall({ id: 'tc_2', function: { name: 'deploy_app', arguments: {} } });
    const tc3 = makeToolCall({ id: 'tc_3', function: { name: 'deploy_app', arguments: {} } });

    const result = await processToolCallsFn(get, set, [tc1, tc2, tc3], 'asst_1', {
      content: '',
      thinking: '',
      toolCalls: [tc1, tc2, tc3],
    });

    expect(result.shouldContinue).toBe(false);
    expect(state.pendingConfirmation).not.toBeNull();
    expect(state.pendingConfirmation!.action.toolName).toBe('batch_deploy');

    const entries = state.pendingConfirmation!.action.args.entries as Array<{ app_name: string }>;
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.app_name)).toEqual(['tetris', 'hextris']);

    // The failed tool message should contain the error
    const errorMsg = state.messages.find(m => m.role === 'tool' && m.error);
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.error).toBe('Hash computation failed');
  });

  it('uses single confirmation for mixed TX types and marks others as skipped', async () => {
    vi.mocked(executeTool)
      .mockResolvedValueOnce({
        success: true,
        requiresConfirmation: true,
        confirmationMessage: 'Deploy tetris?',
        pendingAction: { toolName: 'deploy_app', args: { app_name: 'tetris' } },
      })
      .mockResolvedValueOnce({
        success: true,
        requiresConfirmation: true,
        confirmationMessage: 'Stop myapp?',
        pendingAction: { toolName: 'stop_app', args: { app_name: 'myapp' } },
      });

    const assistantMsg = makeMessage({ id: 'asst_1' });
    state.messages = [assistantMsg];

    const tc1 = makeToolCall({ id: 'tc_1', function: { name: 'deploy_app', arguments: {} } });
    const tc2 = makeToolCall({ id: 'tc_2', function: { name: 'stop_app', arguments: {} } });

    const result = await processToolCallsFn(get, set, [tc1, tc2], 'asst_1', {
      content: '',
      thinking: '',
      toolCalls: [tc1, tc2],
    });

    expect(result.shouldContinue).toBe(false);
    expect(executeTool).toHaveBeenCalledTimes(2);
    // Mixed types → first confirmation wins (single, not batch)
    expect(state.pendingConfirmation).not.toBeNull();
    expect(state.pendingConfirmation!.action.toolName).toBe('deploy_app');

    // Second confirmation should be marked as skipped
    const skippedMsg = state.messages.find(m => m.role === 'tool' && m.content === 'Skipped: only one transaction can be confirmed at a time.');
    expect(skippedMsg).toBeDefined();
  });
});
