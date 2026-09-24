import { describe, it, expect, vi } from 'vitest';

vi.mock('../../ai/systemPrompt', () => ({
  getSystemPrompt: vi.fn((address?: string) => `system prompt for ${address ?? 'anon'}`),
}));

vi.mock('../../registry/appRegistry', () => ({
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => null),
  findApp: vi.fn(() => null),
  getAppByLease: vi.fn(() => null),
  discoverAppsFromChain: vi.fn(() => []),
  addApp: vi.fn(),
  updateApp: vi.fn(),
}));

import { toChatApiMessages, generateMessageId, trimMessages, createAssistantMessage } from './utils';
import type { ChatMessage } from '../../contexts/aiTypes';
import { compactMessagesForRelay, serializeMessagesForApi, type ChatApiMessage } from '../../api/morpheus';
import { historyStorageKey, loadHistory, saveHistory } from './persistence';
import { createWalletIdentity } from '../../utils/walletIdentity';

describe('toChatApiMessages', () => {
  it('prepends a system prompt message', () => {
    const result = toChatApiMessages([], 'manifest1abc');

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('system prompt for manifest1abc');
  });

  it('filters out streaming messages', () => {
    const msgs: ChatMessage[] = [
      { id: '1', role: 'user', content: 'hello', timestamp: 1 },
      { id: '2', role: 'assistant', content: 'partial', timestamp: 2, isStreaming: true },
      { id: '3', role: 'assistant', content: 'done', timestamp: 3, isStreaming: false },
    ];

    const result = toChatApiMessages(msgs, undefined);

    // system + user + non-streaming assistant = 3
    expect(result).toHaveLength(3);
    expect(result.map(m => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(result[2].content).toBe('done');
  });

  it('filters a persisted transaction row until its executor resolves', () => {
    const msgs: ChatMessage[] = [
      { id: '1', role: 'user', content: 'deploy redis', timestamp: 1 },
      {
        id: '2', role: 'assistant', content: 'Calling tools.', timestamp: 2,
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'deploy_app', arguments: {} } }],
      },
      {
        id: '3', role: 'tool', content: 'Deploy redis?', timestamp: 3,
        toolCallId: 'tc_1', transactionInFlight: true,
      },
    ];

    const result = toChatApiMessages(msgs, undefined);

    expect(result.map((message) => message.role)).toEqual(['system', 'user', 'assistant']);
    expect(result.some((message) => message.role === 'tool')).toBe(false);
  });

  it('converts tool role messages with tool_call_id', () => {
    // Tool preceded by its assistant (with tool_calls) so it is not a leading
    // orphan — the strip only removes a tool run at the very front of the window.
    const msgs: ChatMessage[] = [
      {
        id: '0',
        role: 'assistant',
        content: 'Calling tools.',
        timestamp: 0,
        toolCalls: [{ id: 'tc_42', type: 'function', function: { name: 'get_balance', arguments: {} } }],
      },
      { id: '1', role: 'tool', content: '{"result": "ok"}', timestamp: 1, toolCallId: 'tc_42' },
    ];

    const result = toChatApiMessages(msgs, undefined);

    expect(result).toHaveLength(3); // system + assistant + tool
    const toolMsg = result.find((m) => m.role === 'tool');
    expect(toolMsg).toEqual({
      role: 'tool',
      content: '{"result": "ok"}',
      tool_call_id: 'tc_42',
    });
  });

  it('inserts placeholder content for assistant messages with tool_calls but empty content', () => {
    const msgs: ChatMessage[] = [
      {
        id: '1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'list_apps', arguments: {} } }],
      },
    ];

    const result = toChatApiMessages(msgs, undefined);

    expect(result).toHaveLength(2); // system + assistant
    expect(result[1].content).toBe('Calling tools.');
    expect(result[1].tool_calls).toEqual(msgs[0].toolCalls);
  });

  it('drops local-only synthesized messages from the API stream', () => {
    const msgs: ChatMessage[] = [
      { id: '1', role: 'user', content: 'hi', timestamp: 1 },
      { id: '2', role: 'assistant', content: 'UI canned help text', timestamp: 2, local: true },
      { id: '3', role: 'user', content: 'next', timestamp: 3 },
    ];

    const result = toChatApiMessages(msgs, undefined);

    // System prompt + user + user — the local assistant message is filtered out.
    expect(result.length).toBe(3);
    expect(result.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(result.some((m) => 'content' in m && m.content === 'UI canned help text')).toBe(false);
  });

  it('preserves content for assistant messages with tool_calls and non-empty content', () => {
    const msgs: ChatMessage[] = [
      {
        id: '1',
        role: 'assistant',
        content: 'Let me check that.',
        timestamp: 1,
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'list_apps', arguments: {} } }],
      },
    ];

    const result = toChatApiMessages(msgs, undefined);

    expect(result[1].content).toBe('Let me check that.');
  });

  it('passes address to getSystemPrompt', () => {
    const result = toChatApiMessages([], 'manifest1xyz');
    expect(result[0].content).toContain('manifest1xyz');
  });

  it('inserts synthetic assistant message between tool and user messages', () => {
    const msgs: ChatMessage[] = [
      { id: '1', role: 'user', content: 'show logs', timestamp: 1 },
      {
        id: '2',
        role: 'assistant',
        content: 'Calling tools.',
        timestamp: 2,
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'get_logs', arguments: {} } }],
      },
      { id: '3', role: 'tool', content: '{"logs":"..."}', timestamp: 3, toolCallId: 'tc_1' },
      { id: '4', role: 'user', content: 'thanks', timestamp: 4 },
    ];

    const result = toChatApiMessages(msgs, undefined);

    // system + user + assistant(toolCalls) + tool + synthetic assistant + user = 6
    expect(result).toHaveLength(6);
    expect(result.map(m => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'assistant', 'user',
    ]);
    expect(result[4].content).toBe('Tool execution complete.');
  });

  it('does not insert synthetic assistant when tool is followed by assistant', () => {
    const msgs: ChatMessage[] = [
      { id: '1', role: 'user', content: 'list apps', timestamp: 1 },
      {
        id: '2',
        role: 'assistant',
        content: 'Calling tools.',
        timestamp: 2,
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'list_apps', arguments: {} } }],
      },
      { id: '3', role: 'tool', content: '[]', timestamp: 3, toolCallId: 'tc_1' },
      { id: '4', role: 'assistant', content: 'No apps running.', timestamp: 4 },
    ];

    const result = toChatApiMessages(msgs, undefined);

    // system + user + assistant + tool + assistant = 5 (no synthetic)
    expect(result).toHaveLength(5);
    expect(result.map(m => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'assistant',
    ]);
    expect(result[4].content).toBe('No apps running.');
  });

  it('handles multiple tool results before user message', () => {
    const msgs: ChatMessage[] = [
      { id: '1', role: 'user', content: 'check', timestamp: 1 },
      {
        id: '2',
        role: 'assistant',
        content: 'Calling tools.',
        timestamp: 2,
        toolCalls: [
          { id: 'tc_1', type: 'function', function: { name: 'get_balance', arguments: {} } },
          { id: 'tc_2', type: 'function', function: { name: 'list_apps', arguments: {} } },
        ],
      },
      { id: '3', role: 'tool', content: '{"credits":100}', timestamp: 3, toolCallId: 'tc_1' },
      { id: '4', role: 'tool', content: '[]', timestamp: 4, toolCallId: 'tc_2' },
      { id: '5', role: 'user', content: 'ok', timestamp: 5 },
    ];

    const result = toChatApiMessages(msgs, undefined);

    // system + user + assistant + tool + tool + synthetic assistant + user = 7
    expect(result).toHaveLength(7);
    expect(result.map(m => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'tool', 'assistant', 'user',
    ]);
  });

  it('handles displayCard flow: tool is last message before next user message (the show-logs→stop bug)', () => {
    // Reproduces the exact scenario: "show me tetris logs" returns displayCard
    // (no final assistant message), then user sends "stop tetris"
    const msgs: ChatMessage[] = [
      { id: '1', role: 'user', content: 'show me tetris logs', timestamp: 1 },
      {
        id: '2',
        role: 'assistant',
        content: 'Calling tools.',
        timestamp: 2,
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'get_logs', arguments: { app_name: 'tetris' } } }],
      },
      // displayCard flow ends here — no final assistant message
      { id: '3', role: 'tool', content: '{"logs":"game loop started..."}', timestamp: 3, toolCallId: 'tc_1' },
      { id: '4', role: 'user', content: 'stop tetris', timestamp: 4 },
    ];

    const result = toChatApiMessages(msgs, undefined);

    expect(result.map(m => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'assistant', 'user',
    ]);
    expect(result[4].content).toBe('Tool execution complete.');
  });

  it('handles multiple tool→user transitions across conversation history', () => {
    // Two rounds of tool calls, each ending with displayCard (no final assistant)
    const msgs: ChatMessage[] = [
      { id: '1', role: 'user', content: 'show logs', timestamp: 1 },
      {
        id: '2',
        role: 'assistant',
        content: 'Calling tools.',
        timestamp: 2,
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'get_logs', arguments: {} } }],
      },
      { id: '3', role: 'tool', content: 'logs...', timestamp: 3, toolCallId: 'tc_1' },
      // First tool→user transition
      { id: '4', role: 'user', content: 'check status', timestamp: 4 },
      {
        id: '5',
        role: 'assistant',
        content: 'Calling tools.',
        timestamp: 5,
        toolCalls: [{ id: 'tc_2', type: 'function', function: { name: 'app_status', arguments: {} } }],
      },
      { id: '6', role: 'tool', content: 'status...', timestamp: 6, toolCallId: 'tc_2' },
      // Second tool→user transition
      { id: '7', role: 'user', content: 'stop it', timestamp: 7 },
    ];

    const result = toChatApiMessages(msgs, undefined);

    expect(result.map(m => m.role)).toEqual([
      'system',
      'user', 'assistant', 'tool', 'assistant', // synthetic
      'user', 'assistant', 'tool', 'assistant', // synthetic
      'user',
    ]);
  });

  it('does not insert synthetic assistant when tool is the last message', () => {
    // After confirmation flow: tool result is the last message, next will be a new assistant stream
    const msgs: ChatMessage[] = [
      { id: '1', role: 'user', content: 'stop tetris', timestamp: 1 },
      {
        id: '2',
        role: 'assistant',
        content: 'Calling tools.',
        timestamp: 2,
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'stop_app', arguments: {} } }],
      },
      { id: '3', role: 'tool', content: '{"success":true}', timestamp: 3, toolCallId: 'tc_1' },
    ];

    const result = toChatApiMessages(msgs, undefined);

    // No synthetic needed — tool is last, next message will be generated by the model
    expect(result.map(m => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool',
    ]);
  });

  it('filters streaming tool messages and still inserts synthetic for remaining tool→user', () => {
    // A streaming tool message gets filtered out, but a completed tool before it
    // still needs the fix when followed by a user message
    const msgs: ChatMessage[] = [
      { id: '1', role: 'user', content: 'check', timestamp: 1 },
      {
        id: '2',
        role: 'assistant',
        content: 'Calling tools.',
        timestamp: 2,
        toolCalls: [
          { id: 'tc_1', type: 'function', function: { name: 'get_balance', arguments: {} } },
          { id: 'tc_2', type: 'function', function: { name: 'list_apps', arguments: {} } },
        ],
      },
      { id: '3', role: 'tool', content: '{"credits":100}', timestamp: 3, toolCallId: 'tc_1' },
      // Second tool still streaming — will be filtered out
      { id: '4', role: 'tool', content: 'loading...', timestamp: 4, toolCallId: 'tc_2', isStreaming: true },
      { id: '5', role: 'user', content: 'next', timestamp: 5 },
    ];

    const result = toChatApiMessages(msgs, undefined);

    // Streaming tool filtered: system + user + assistant + tool + synthetic assistant + user
    expect(result.map(m => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'assistant', 'user',
    ]);
  });

  it('handles confirmation flow message sequence (tool result followed by assistant stream)', () => {
    // After confirmAction executes: messages have the TX tool result,
    // then confirmAction calls toChatApiMessages excluding the new streaming assistant
    const msgs: ChatMessage[] = [
      { id: '1', role: 'user', content: 'show logs', timestamp: 1 },
      {
        id: '2',
        role: 'assistant',
        content: 'Calling tools.',
        timestamp: 2,
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'get_logs', arguments: {} } }],
      },
      { id: '3', role: 'tool', content: 'logs output', timestamp: 3, toolCallId: 'tc_1' },
      // No final assistant (displayCard flow), then user sends stop command
      { id: '4', role: 'user', content: 'stop tetris', timestamp: 4 },
      {
        id: '5',
        role: 'assistant',
        content: 'Calling tools.',
        timestamp: 5,
        toolCalls: [{ id: 'tc_2', type: 'function', function: { name: 'stop_app', arguments: {} } }],
      },
      // Confirmation completed — tool result updated with TX result
      { id: '6', role: 'tool', content: '{"success":true}', timestamp: 6, toolCallId: 'tc_2' },
    ];

    const result = toChatApiMessages(msgs, undefined);

    // The first tool→user gap gets a synthetic assistant; the final tool is last (no insertion)
    expect(result.map(m => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool',
    ]);
  });

  it('strips leading orphan tool messages (window sliced mid tool-call group)', () => {
    // A tail slice can start the window mid tool-call group — leaving leading
    // tool messages whose assistant (with tool_calls) was dropped. OpenAI-
    // compatible backends 400 on that, so the leading tool run must be stripped.
    const msgs: ChatMessage[] = [
      { id: '1', role: 'tool', content: '{"credits":100}', timestamp: 1, toolCallId: 'tc_1' },
      { id: '2', role: 'tool', content: '[]', timestamp: 2, toolCallId: 'tc_2' },
      { id: '3', role: 'user', content: 'hi', timestamp: 3 },
      { id: '4', role: 'assistant', content: 'hello', timestamp: 4 },
    ];

    const result = toChatApiMessages(msgs, undefined);

    expect(result.map(m => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(result.some(m => m.role === 'tool')).toBe(false);
  });

  it('strips only the leading orphan tool run, keeping a later valid tool group', () => {
    const msgs: ChatMessage[] = [
      // Orphaned leading tool (its assistant fell off the front of the window)
      { id: '1', role: 'tool', content: 'orphan', timestamp: 1, toolCallId: 'tc_0' },
      { id: '2', role: 'user', content: 'check', timestamp: 2 },
      {
        id: '3',
        role: 'assistant',
        content: 'Calling tools.',
        timestamp: 3,
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'get_balance', arguments: {} } }],
      },
      { id: '4', role: 'tool', content: '{"credits":100}', timestamp: 4, toolCallId: 'tc_1' },
    ];

    const result = toChatApiMessages(msgs, undefined);

    expect(result.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  });

  it('preserves a saved recovery result as historical context in the next actual relay request', () => {
    const identity = createWalletIdentity('manifest-test', 'manifest1historyprotocol')!;
    const error = 'Restart is unconfirmed. Check app_status and app_releases. Recover the original command with its same key and exact payload. Do not submit a new command.';
    const content = JSON.stringify({ success: false, error });
    const advice = [{ operation: 'restart' as const, idempotencyKey: '11111111-1111-4111-8111-111111111111',
      address: identity.address, chainId: identity.chainId, providerUrl: 'https://provider.example',
      leaseUuid: '22222222-2222-4222-8222-222222222222', rpcUrl: 'https://rpc.example', restUrl: 'https://rest.example' }];
    const messages: ChatMessage[] = [
      { id: 'request', role: 'user', content: 'Restart web', timestamp: 1 },
      { id: 'call', role: 'assistant', content: 'Calling tools.', timestamp: 2,
        toolCalls: [{ id: 'restart-call', type: 'function', function: { name: 'restart_app', arguments: { app_name: 'web' } } }] },
      { id: 'result', role: 'tool', toolName: 'restart_app', toolCallId: 'restart-call', timestamp: 3,
        content, error, maintenanceRecoveryAdvice: advice },
    ];
    try {
      saveHistory(identity, messages, true);
      const restored = loadHistory(identity);
      expect(restored[1].toolCalls).toBeUndefined();
      expect(restored[2]).toMatchObject({ role: 'tool', toolCallId: 'restart-call', content, error, maintenanceRecoveryAdvice: advice });
      const next = [...restored, { id: 'observe', role: 'user' as const, timestamp: 4,
        content: 'Check app_status and app_releases for the affected apps before any further maintenance.' }];
      const wire = serializeMessagesForApi(compactMessagesForRelay(toChatApiMessages(next, identity.address))) as ChatApiMessage[];
      expect(wire.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'assistant', 'user']);
      expect(wire[3]).toEqual({ role: 'assistant', content: `Historical tool result:\n${content}` });
      expect(JSON.stringify(wire)).not.toMatch(/maintenanceRecoveryAdvice|idempotencyKey|tool_call_id|tool_calls/);
      expect(restored[2].maintenanceRecoveryAdvice).toEqual(advice);
      expect(messages[1].toolCalls).toHaveLength(1);
    } finally { localStorage.removeItem(historyStorageKey(identity)); }
  });

  it('matches only adjacent live call IDs while preserving a parallel tool group', () => {
    const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'app_status', arguments: {} } });
    const msgs: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Check two apps', timestamp: 1 },
      { id: '2', role: 'assistant', content: '', timestamp: 2, toolCalls: [call('a'), call('b')] },
      { id: '3', role: 'tool', content: 'second result', timestamp: 3, toolCallId: 'b' },
      { id: '4', role: 'tool', content: 'first result', timestamp: 4, toolCallId: 'a' },
      { id: '5', role: 'assistant', content: 'Both observed.', timestamp: 5 },
      { id: '6', role: 'tool', content: 'old detached result', timestamp: 6, toolCallId: 'a' },
      { id: '7', role: 'user', content: 'Check again', timestamp: 7 },
      { id: '8', role: 'assistant', content: '', timestamp: 8, toolCalls: [call('c')] },
      { id: '9', role: 'tool', content: 'fresh result', timestamp: 9, toolCallId: 'c' },
      { id: '10', role: 'tool', content: 'duplicate result', timestamp: 10, toolCallId: 'c' },
      { id: '11', role: 'tool', content: 'missing ID result', timestamp: 11 },
    ];
    const projected = toChatApiMessages(msgs, undefined);
    expect(projected.filter(message => message.role === 'tool')).toEqual([
      { role: 'tool', content: 'second result', tool_call_id: 'b' },
      { role: 'tool', content: 'first result', tool_call_id: 'a' },
      { role: 'tool', content: 'fresh result', tool_call_id: 'c' },
    ]);
    for (const content of ['old detached result', 'duplicate result', 'missing ID result']) {
      expect(projected).toContainEqual({ role: 'assistant', content: `Historical tool result:\n${content}` });
    }
    const pending = new Set<string>();
    for (const message of serializeMessagesForApi(compactMessagesForRelay(projected)) as ChatApiMessage[]) {
      if (message.role === 'tool') {
        expect(pending.delete(message.tool_call_id!)).toBe(true);
      } else {
        pending.clear();
        for (const call of message.tool_calls ?? []) pending.add(call.id);
      }
    }
  });
});

describe('generateMessageId', () => {
  it('returns a string starting with msg_', () => {
    const id = generateMessageId();
    expect(id).toMatch(/^msg_\d+_[a-z0-9]+$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateMessageId()));
    expect(ids.size).toBe(100);
  });
});

describe('trimMessages', () => {
  it('returns messages unchanged when under limit', () => {
    const msgs = [{ id: '1' }] as ChatMessage[];
    expect(trimMessages(msgs)).toBe(msgs);
  });
});

describe('createAssistantMessage', () => {
  it('creates a streaming assistant message', () => {
    const msg = createAssistantMessage();
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('');
    expect(msg.isStreaming).toBe(true);
    expect(msg.id).toMatch(/^msg_/);
  });
});
