import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamChat, listModels, checkOllamaHealth } from './ollama';

// Mock logError to avoid console noise
vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

// Mock withRetry to just call the fn directly
vi.mock('./utils', () => ({
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

const ENDPOINT = 'http://localhost:11434';

/** Helper to create a ReadableStream from NDJSON lines */
function ndjsonStream(lines: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Collect all chunks from an async generator */
async function collectChunks<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('streamChat', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('yields error for invalid endpoint', async () => {
    const chunks = await collectChunks(
      streamChat({ endpoint: 'ftp://invalid', model: 'test', messages: [] })
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ type: 'error', error: 'Invalid Ollama endpoint URL' });
  });

  it('preserves endpoint path prefix in request URL', async () => {
    const body = ndjsonStream([{ done: true }]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, body } as Response);

    await collectChunks(
      streamChat({ endpoint: 'https://example.com/api/ollama', model: 'test', messages: [] })
    );

    const calledUrl = vi.mocked(fetch).mock.calls[0][0];
    expect(calledUrl).toBe('https://example.com/api/ollama/api/chat');
  });

  it('yields content chunks from streaming response', async () => {
    const body = ndjsonStream([
      { message: { content: 'Hello' } },
      { message: { content: ' world' } },
      { done: true },
    ]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, body } as Response);

    const chunks = await collectChunks(
      streamChat({ endpoint: ENDPOINT, model: 'test', messages: [] })
    );

    expect(chunks).toEqual([
      { type: 'content', content: 'Hello' },
      { type: 'content', content: ' world' },
      { type: 'done' },
    ]);
  });

  it('yields thinking chunks', async () => {
    const body = ndjsonStream([
      { message: { thinking: 'Let me think...' } },
      { message: { content: 'Answer' } },
      { done: true },
    ]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, body } as Response);

    const chunks = await collectChunks(
      streamChat({ endpoint: ENDPOINT, model: 'test', messages: [], think: true })
    );

    expect(chunks[0]).toEqual({ type: 'thinking', content: 'Let me think...' });
    expect(chunks[1]).toEqual({ type: 'content', content: 'Answer' });
  });

  it('yields tool_call chunks with proper structure', async () => {
    const body = ndjsonStream([
      {
        message: {
          tool_calls: [{
            id: 'tc-1',
            function: { name: 'list_apps', arguments: { state: 'running' } },
          }],
        },
      },
      { done: true },
    ]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, body } as Response);

    const chunks = await collectChunks(
      streamChat({ endpoint: ENDPOINT, model: 'test', messages: [] })
    );

    expect(chunks[0]).toEqual({
      type: 'tool_call',
      toolCall: {
        id: 'tc-1',
        type: 'function',
        function: { name: 'list_apps', arguments: { state: 'running' } },
      },
    });
  });

  it('generates synthetic ID for tool calls without ID', async () => {
    const body = ndjsonStream([
      {
        message: {
          tool_calls: [{
            function: { name: 'get_balance', arguments: {} },
          }],
        },
      },
      { done: true },
    ]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, body } as Response);

    const chunks = await collectChunks(
      streamChat({ endpoint: ENDPOINT, model: 'test', messages: [] })
    );

    const toolChunk = chunks[0];
    expect(toolChunk.type).toBe('tool_call');
    if (toolChunk.type === 'tool_call') {
      expect(toolChunk.toolCall.id).toBeTruthy();
      expect(toolChunk.toolCall.function.name).toBe('get_balance');
    }
  });

  it('skips tool calls with missing function name', async () => {
    const body = ndjsonStream([
      {
        message: {
          tool_calls: [
            { function: { name: '', arguments: {} } },
            { function: { arguments: {} } },
          ],
        },
      },
      { done: true },
    ]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, body } as Response);

    const chunks = await collectChunks(
      streamChat({ endpoint: ENDPOINT, model: 'test', messages: [] })
    );

    // No tool_call chunks, just done
    expect(chunks).toEqual([{ type: 'done' }]);
  });

  it('parses string arguments in tool calls', async () => {
    const body = ndjsonStream([
      {
        message: {
          tool_calls: [{
            id: 'tc-1',
            function: { name: 'deploy_app', arguments: '{"image":"redis:8.4"}' },
          }],
        },
      },
      { done: true },
    ]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, body } as Response);

    const chunks = await collectChunks(
      streamChat({ endpoint: ENDPOINT, model: 'test', messages: [] })
    );

    if (chunks[0].type === 'tool_call') {
      expect(chunks[0].toolCall.function.arguments).toEqual({ image: 'redis:8.4' });
    }
  });

  it('defaults to empty args when argument JSON is invalid', async () => {
    const body = ndjsonStream([
      {
        message: {
          tool_calls: [{
            id: 'tc-1',
            function: { name: 'list_apps', arguments: '{bad json' },
          }],
        },
      },
      { done: true },
    ]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, body } as Response);

    const chunks = await collectChunks(
      streamChat({ endpoint: ENDPOINT, model: 'test', messages: [] })
    );

    if (chunks[0].type === 'tool_call') {
      expect(chunks[0].toolCall.function.arguments).toEqual({});
    }
  });

  it('yields error for non-ok HTTP response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as unknown as Response);

    const chunks = await collectChunks(
      streamChat({ endpoint: ENDPOINT, model: 'test', messages: [] })
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('error');
    if (chunks[0].type === 'error') {
      expect(chunks[0].error).toContain('500');
    }
  });

  it('yields error when response has no body', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, body: null } as Response);

    const chunks = await collectChunks(
      streamChat({ endpoint: ENDPOINT, model: 'test', messages: [] })
    );

    expect(chunks).toEqual([{ type: 'error', error: 'No response body from Ollama' }]);
  });

  it('yields done when user aborts via signal', async () => {
    const controller = new AbortController();
    controller.abort();

    vi.mocked(fetch).mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const chunks = await collectChunks(
      streamChat({
        endpoint: ENDPOINT,
        model: 'test',
        messages: [],
        signal: controller.signal,
      })
    );

    expect(chunks).toEqual([{ type: 'done' }]);
  });

  it('includes tools in request body when provided', async () => {
    const body = ndjsonStream([{ done: true }]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, body } as Response);

    const tools = [{
      type: 'function' as const,
      function: {
        name: 'test_tool',
        description: 'test',
        parameters: { type: 'object' as const, properties: {} },
      },
    }];

    await collectChunks(
      streamChat({ endpoint: ENDPOINT, model: 'test', messages: [], tools })
    );

    const requestBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(requestBody.tools).toEqual(tools);
    expect(requestBody.stream).toBe(true);
  });

  it('includes think flag in request body when enabled', async () => {
    const body = ndjsonStream([{ done: true }]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, body } as Response);

    await collectChunks(
      streamChat({ endpoint: ENDPOINT, model: 'test', messages: [], think: true })
    );

    const requestBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(requestBody.think).toBe(true);
  });

  it('handles malformed NDJSON lines gracefully', async () => {
    // Create a stream with a mix of valid and invalid JSON
    const encoder = new TextEncoder();
    const text = '{"message":{"content":"ok"}}\n{bad json}\n{"done":true}\n';
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
    vi.mocked(fetch).mockResolvedValue({ ok: true, body } as Response);

    const chunks = await collectChunks(
      streamChat({ endpoint: ENDPOINT, model: 'test', messages: [] })
    );

    // Should get content from valid line and done, skipping bad line
    expect(chunks[0]).toEqual({ type: 'content', content: 'ok' });
    expect(chunks[chunks.length - 1]).toEqual({ type: 'done' });
  });
});

describe('listModels', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns models from API', async () => {
    const models = [{ name: 'llama3', modified_at: '2024-01-01', size: 1000 }];
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ models }),
    } as unknown as Response);

    const result = await listModels(ENDPOINT);
    expect(result).toEqual(models);
  });

  it('returns empty array for invalid endpoint', async () => {
    const result = await listModels('ftp://bad');
    expect(result).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns empty array on fetch failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network error'));

    const result = await listModels(ENDPOINT);
    expect(result).toEqual([]);
  });

  it('returns empty array when models key is missing', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as unknown as Response);

    const result = await listModels(ENDPOINT);
    expect(result).toEqual([]);
  });
});

describe('checkOllamaHealth', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true for healthy endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    expect(await checkOllamaHealth(ENDPOINT)).toBe(true);
  });

  it('returns false for unhealthy endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
    expect(await checkOllamaHealth(ENDPOINT)).toBe(false);
  });

  it('returns false for invalid endpoint', async () => {
    expect(await checkOllamaHealth('ftp://bad')).toBe(false);
  });

  it('returns false on network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('connection refused'));
    expect(await checkOllamaHealth(ENDPOINT)).toBe(false);
  });
});
