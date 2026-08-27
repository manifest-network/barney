import { afterEach, describe, it, expect, vi } from 'vitest';
import { stripToolCallLeaks, processStreamWithTimeout } from './streamUtils';
import type { StreamChunk } from '../api/morpheus';

afterEach(() => {
  vi.useRealTimers();
});

// Helper: create an async generator from an array of chunks
async function* chunksFrom(items: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const item of items) {
    yield item;
  }
}

// ============================================================================
// stripToolCallLeaks
// ============================================================================

describe('stripToolCallLeaks', () => {
  it('strips paired [TOOL_CALLS] markers and content between them', () => {
    expect(stripToolCallLeaks('Hello [TOOL_CALLS]{"name":"foo"}[TOOL_CALLS] world'))
      .toBe('Hello  world');
  });

  it('strips single [TOOL_CALLS] prefix followed by JSON array', () => {
    expect(stripToolCallLeaks('Hello [TOOL_CALLS][{"name":"foo"}]'))
      .toBe('Hello');
  });

  it('strips single [TOOL_CALLS] prefix followed by JSON object', () => {
    expect(stripToolCallLeaks('Hello [TOOL_CALLS]{"name":"foo"}'))
      .toBe('Hello');
  });

  it('strips bare [TOOL_CALLS] marker with no content', () => {
    expect(stripToolCallLeaks('Hello [TOOL_CALLS]')).toBe('Hello');
  });

  it('returns text unchanged when no markers present', () => {
    expect(stripToolCallLeaks('Hello world')).toBe('Hello world');
  });

  it('trims surrounding whitespace on the no-marker fast path', () => {
    expect(stripToolCallLeaks('  Hello  ')).toBe('Hello');
  });

  it('handles empty string', () => {
    expect(stripToolCallLeaks('')).toBe('');
  });

  it('strips multiple occurrences', () => {
    expect(stripToolCallLeaks('[TOOL_CALLS]a[TOOL_CALLS] mid [TOOL_CALLS]b[TOOL_CALLS]'))
      .toBe('mid');
  });
});

// ============================================================================
// processStreamWithTimeout
// ============================================================================

describe('processStreamWithTimeout', () => {
  it('accumulates content chunks and calls onChunk', async () => {
    const chunks: StreamChunk[] = [
      { type: 'content', content: 'Hello ' },
      { type: 'content', content: 'world' },
    ];

    const onChunk = vi.fn();
    const result = await processStreamWithTimeout(chunksFrom(chunks), onChunk, 5000);

    expect(result.content).toBe('Hello world');
    expect(result.thinking).toBe('');
    expect(result.toolCalls).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(onChunk).toHaveBeenCalledTimes(2);
  });

  it('accumulates thinking chunks', async () => {
    const chunks: StreamChunk[] = [
      { type: 'thinking', content: 'Let me think...' },
      { type: 'content', content: 'Answer' },
    ];

    const onChunk = vi.fn();
    const result = await processStreamWithTimeout(chunksFrom(chunks), onChunk, 5000);

    expect(result.thinking).toBe('Let me think...');
    expect(result.content).toBe('Answer');
  });

  it('collects tool calls', async () => {
    const toolCall = {
      id: 'tc1',
      type: 'function' as const,
      function: { name: 'get_balance', arguments: {} },
    };
    const chunks: StreamChunk[] = [
      { type: 'content', content: 'Checking...' },
      { type: 'tool_call', toolCall },
    ];

    const onChunk = vi.fn();
    const result = await processStreamWithTimeout(chunksFrom(chunks), onChunk, 5000);

    expect(result.toolCalls).toEqual([toolCall]);
  });

  it('short-circuits on error chunk and returns accumulated content', async () => {
    const chunks: StreamChunk[] = [
      { type: 'content', content: 'Partial ' },
      { type: 'error', error: 'connection reset' },
      { type: 'content', content: 'should not reach' },
    ];

    const onChunk = vi.fn();
    const result = await processStreamWithTimeout(chunksFrom(chunks), onChunk, 5000);

    expect(result.error).toBe('connection reset');
    expect(result.content).toBe('Partial');
    expect(onChunk).toHaveBeenCalledTimes(1);
  });

  it('strips tool call leaks from final content', async () => {
    const chunks: StreamChunk[] = [
      { type: 'content', content: 'Result [TOOL_CALLS]{"x":1}' },
    ];

    const onChunk = vi.fn();
    const result = await processStreamWithTimeout(chunksFrom(chunks), onChunk, 5000);

    expect(result.content).toBe('Result');
  });

  it('throws on timeout when stream stalls', async () => {
    async function* slowStream(): AsyncGenerator<StreamChunk> {
      yield { type: 'content', content: 'start' };
      // Sleep longer than the timeout but short enough for generator.return() cleanup
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const onChunk = vi.fn();
    await expect(
      processStreamWithTimeout(slowStream(), onChunk, 50)
    ).rejects.toThrow('Stream timeout');
  });

  it('uses a separate longer timeout for wallet authentication and the initial response', async () => {
    vi.useFakeTimers();
    async function* delayedInitialStream(): AsyncGenerator<StreamChunk> {
      await new Promise((resolve) => setTimeout(resolve, 100));
      yield { type: 'content', content: 'authenticated' };
    }

    const resultPromise = processStreamWithTimeout(
      delayedInitialStream(),
      vi.fn(),
      50,
      200,
    );
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toMatchObject({ content: 'authenticated' });
  });

  it('surfaces an initial-session timeout without waiting for the pending generator step', async () => {
    vi.useFakeTimers();
    async function* stalledInitialStream(): AsyncGenerator<StreamChunk> {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      yield { type: 'content', content: 'too late' };
    }

    const resultPromise = processStreamWithTimeout(
      stalledInitialStream(),
      vi.fn(),
      50,
      200,
    );
    const rejection = expect(resultPromise).rejects.toThrow('Session timeout');
    await vi.advanceTimersByTimeAsync(200);

    await rejection;
  });

  it('handles empty stream', async () => {
    const onChunk = vi.fn();
    const result = await processStreamWithTimeout(chunksFrom([]), onChunk, 5000);

    expect(result.content).toBe('');
    expect(result.thinking).toBe('');
    expect(result.toolCalls).toEqual([]);
    expect(onChunk).not.toHaveBeenCalled();
  });
});
