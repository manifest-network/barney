import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

// Must import after mocks
import { serializeMessagesForApi } from './morpheus';
import type { ChatApiMessage, ToolCall } from './morpheus';

describe('serializeMessagesForApi', () => {
  it('passes through messages without tool_calls unchanged', () => {
    const messages: ChatApiMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ];
    const result = serializeMessagesForApi(messages);
    expect(result).toEqual(messages);
  });

  it('converts tool_calls arguments from object to JSON string', () => {
    const toolCall: ToolCall = {
      id: 'tc1',
      type: 'function',
      function: {
        name: 'list_apps',
        arguments: { state: 'running' },
      },
    };
    const messages: ChatApiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [toolCall] },
    ];
    const result = serializeMessagesForApi(messages);
    const serialized = result[0] as Record<string, unknown>;
    const tcs = serialized.tool_calls as Array<Record<string, unknown>>;
    expect(tcs[0].function).toEqual({
      name: 'list_apps',
      arguments: '{"state":"running"}',
    });
  });

  it('passes through already-string arguments', () => {
    const toolCall: ToolCall = {
      id: 'tc1',
      type: 'function',
      function: {
        name: 'list_apps',
        arguments: '{"state":"running"}' as unknown as Record<string, unknown>,
      },
    };
    const messages: ChatApiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [toolCall] },
    ];
    const result = serializeMessagesForApi(messages);
    const serialized = result[0] as Record<string, unknown>;
    const tcs = serialized.tool_calls as Array<Record<string, unknown>>;
    expect((tcs[0].function as Record<string, unknown>).arguments).toBe('{"state":"running"}');
  });

  it('handles empty tool_calls array', () => {
    const messages: ChatApiMessage[] = [
      { role: 'assistant', content: 'No tools', tool_calls: [] },
    ];
    const result = serializeMessagesForApi(messages);
    expect(result).toEqual(messages);
  });
});

describe('streamChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('yields error for invalid API URL', async () => {
    // Dynamic import to get streamChat after mocks
    const { streamChat } = await import('./morpheus');
    const chunks: Array<{ type: string; error?: string }> = [];

    for await (const chunk of streamChat({
      apiUrl: 'ftp://bad-protocol.com',
      apiKey: 'key',
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('error');
    expect(chunks[0].error).toContain('Invalid AI API endpoint URL');
  });
});

describe('checkApiHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('returns true when models endpoint responds ok', async () => {
    const { checkApiHealth } = await import('./morpheus');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const result = await checkApiHealth('https://api.mor.org/api/v1', 'test-key');
    expect(result).toBe(true);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain('/models');
    expect((fetchCall[1]?.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
  });

  it('returns false when models endpoint responds not ok', async () => {
    const { checkApiHealth } = await import('./morpheus');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    const result = await checkApiHealth('https://api.mor.org/api/v1', 'test-key');
    expect(result).toBe(false);
  });

  it('returns false when fetch throws', async () => {
    const { checkApiHealth } = await import('./morpheus');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const result = await checkApiHealth('https://api.mor.org/api/v1', 'test-key');
    expect(result).toBe(false);
  });

  it('appends /models to the API URL', async () => {
    const { checkApiHealth } = await import('./morpheus');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await checkApiHealth('https://api.mor.org/api/v1', 'test-key');

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    expect(url).toContain('/v1/models');
  });
});
