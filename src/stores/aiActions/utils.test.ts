import { describe, it, expect, vi } from 'vitest';

vi.mock('../../ai/systemPrompt', () => ({
  getSystemPrompt: vi.fn((address?: string) => `system prompt for ${address ?? 'anon'}`),
}));

vi.mock('../../registry/appRegistry', () => ({
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => null),
  findApp: vi.fn(() => null),
  getAppByLease: vi.fn(() => null),
  addApp: vi.fn(),
  updateApp: vi.fn(),
}));

import { toChatApiMessages, generateMessageId, trimMessages, createAssistantMessage } from './utils';
import type { ChatMessage } from '../../contexts/aiTypes';

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

  it('converts tool role messages with tool_call_id', () => {
    const msgs: ChatMessage[] = [
      { id: '1', role: 'tool', content: '{"result": "ok"}', timestamp: 1, toolCallId: 'tc_42' },
    ];

    const result = toChatApiMessages(msgs, undefined);

    expect(result).toHaveLength(2); // system + tool
    expect(result[1]).toEqual({
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
