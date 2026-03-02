import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

// Must import after mocks
import { serializeMessagesForApi, streamChat } from './morpheus';
import type { ChatApiMessage, ToolCall, StreamChunk } from './morpheus';

/** Encode a string as a Uint8Array for ReadableStream chunks. */
function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Build an SSE data line with trailing double-newline. */
function sseEvent(data: string): string {
  return `data: ${data}\n\n`;
}

/** Build a ReadableStream from pre-encoded Uint8Array chunks. */
function makeStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

/** Create a mock fetch Response with the given SSE body chunks. */
function mockFetchWithSSE(chunks: Uint8Array[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    body: makeStream(chunks),
    text: () => Promise.resolve(''),
  });
}

/** Collect all chunks from a streamChat call. */
async function collectChunks(options: Parameters<typeof streamChat>[0]): Promise<StreamChunk[]> {
  const result: StreamChunk[] = [];
  for await (const chunk of streamChat(options)) {
    result.push(chunk);
  }
  return result;
}

const BASE_OPTIONS = {
  apiUrl: 'https://api.mor.org/api/v1',
  apiKey: 'test-key',
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hello' }],
};

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
    const chunks = await collectChunks({
      ...BASE_OPTIONS,
      apiUrl: 'ftp://bad-protocol.com',
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('error');
    expect((chunks[0] as { type: 'error'; error: string }).error).toContain('Invalid AI API endpoint URL');
  });

  it('yields content chunks from SSE stream', async () => {
    vi.stubGlobal('fetch', mockFetchWithSSE([
      encode(
        sseEvent(JSON.stringify({ choices: [{ delta: { content: 'Hello' }, finish_reason: null }] })) +
        sseEvent(JSON.stringify({ choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] }))
      ),
    ]));

    const chunks = await collectChunks(BASE_OPTIONS);

    const contentChunks = chunks.filter((c): c is { type: 'content'; content: string } => c.type === 'content');
    expect(contentChunks).toHaveLength(2);
    expect(contentChunks[0].content).toBe('Hello');
    expect(contentChunks[1].content).toBe(' world');
    expect(chunks[chunks.length - 1].type).toBe('done');
  });

  it('accumulates incremental tool calls and emits on finish_reason=tool_calls', async () => {
    vi.stubGlobal('fetch', mockFetchWithSSE([
      encode(
        // First chunk: tool call id + function name start
        sseEvent(JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'list_', arguments: '' } }] }, finish_reason: null }],
        })) +
        // Second chunk: function name continuation + arguments start
        sseEvent(JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'apps', arguments: '{"sta' } }] }, finish_reason: null }],
        })) +
        // Third chunk: arguments continuation
        sseEvent(JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'te":"running"}' } }] }, finish_reason: null }],
        })) +
        // Finish
        sseEvent(JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        }))
      ),
    ]));

    const chunks = await collectChunks(BASE_OPTIONS);

    const toolChunks = chunks.filter((c): c is { type: 'tool_call'; toolCall: ToolCall } => c.type === 'tool_call');
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0].toolCall.id).toBe('tc_1');
    expect(toolChunks[0].toolCall.function.name).toBe('list_apps');
    expect(toolChunks[0].toolCall.function.arguments).toEqual({ state: 'running' });
    expect(chunks[chunks.length - 1].type).toBe('done');
  });

  it('handles multiple tool calls in parallel', async () => {
    vi.stubGlobal('fetch', mockFetchWithSSE([
      encode(
        sseEvent(JSON.stringify({
          choices: [{ delta: { tool_calls: [
            { index: 0, id: 'tc_1', function: { name: 'list_apps', arguments: '{}' } },
            { index: 1, id: 'tc_2', function: { name: 'get_balance', arguments: '{}' } },
          ] }, finish_reason: null }],
        })) +
        sseEvent(JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        }))
      ),
    ]));

    const chunks = await collectChunks(BASE_OPTIONS);

    const toolChunks = chunks.filter((c): c is { type: 'tool_call'; toolCall: ToolCall } => c.type === 'tool_call');
    expect(toolChunks).toHaveLength(2);
    expect(toolChunks[0].toolCall.function.name).toBe('list_apps');
    expect(toolChunks[1].toolCall.function.name).toBe('get_balance');
  });

  it('yields error from SSE-level error object', async () => {
    vi.stubGlobal('fetch', mockFetchWithSSE([
      encode(sseEvent(JSON.stringify({ error: { message: 'Rate limited' } }))),
    ]));

    const chunks = await collectChunks(BASE_OPTIONS);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('error');
    expect((chunks[0] as { type: 'error'; error: string }).error).toBe('Rate limited');
  });

  it('yields error for non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Too Many Requests'),
    }));

    const chunks = await collectChunks(BASE_OPTIONS);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('error');
    expect((chunks[0] as { type: 'error'; error: string }).error).toContain('429');
  });

  it('handles [DONE] sentinel in SSE stream', async () => {
    vi.stubGlobal('fetch', mockFetchWithSSE([
      encode(
        sseEvent(JSON.stringify({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] })) +
        sseEvent('[DONE]')
      ),
    ]));

    const chunks = await collectChunks(BASE_OPTIONS);

    const contentChunks = chunks.filter(c => c.type === 'content');
    expect(contentChunks).toHaveLength(1);
    // Stream ends with done after [DONE] sentinel
    expect(chunks[chunks.length - 1].type).toBe('done');
  });

  it('emits accumulated tool calls when stream ends without explicit finish_reason', async () => {
    vi.stubGlobal('fetch', mockFetchWithSSE([
      encode(
        sseEvent(JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'get_balance', arguments: '{}' } }] }, finish_reason: null }],
        }))
        // Stream ends (reader.read() returns done) without finish_reason
      ),
    ]));

    const chunks = await collectChunks(BASE_OPTIONS);

    const toolChunks = chunks.filter(c => c.type === 'tool_call');
    expect(toolChunks).toHaveLength(1);
    expect(chunks[chunks.length - 1].type).toBe('done');
  });

  it('skips SSE comments and empty lines', async () => {
    vi.stubGlobal('fetch', mockFetchWithSSE([
      encode(
        ': this is a comment\n\n' +
        '\n\n' +
        sseEvent(JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }))
      ),
    ]));

    const chunks = await collectChunks(BASE_OPTIONS);

    const contentChunks = chunks.filter(c => c.type === 'content');
    expect(contentChunks).toHaveLength(1);
    expect((contentChunks[0] as { type: 'content'; content: string }).content).toBe('ok');
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
