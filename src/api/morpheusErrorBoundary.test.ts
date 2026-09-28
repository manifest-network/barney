import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamChat, serializeMessagesForApi } from './morpheus';
import { processStreamWithTimeout } from '../ai/streamUtils';
import { FAILURE_DETAIL_CHARS } from '../config/constants';
import type { ChatMessage } from '../contexts/aiTypes';
import { createWalletIdentity } from '../utils/walletIdentity';
import { historyStorageKey, loadHistory, saveHistory } from '../stores/aiActions/persistence';
import { toChatApiMessages } from '../stores/aiActions/utils';

vi.mock('./morpheusSession', () => ({
  MorpheusRequestTimeoutError: class MorpheusRequestTimeoutError extends Error {},
  fetchWithMorpheusSession: vi.fn((_auth, input, init) => fetch(input, init)),
}));

const identity = createWalletIdentity('manifest-test', 'manifest1streamerror')!;
const options = {
  messages: [{ role: 'user' as const, content: 'Check my app' }],
  auth: { walletAddress: identity.address, signChallenge: vi.fn() },
};
const raw = `<html>\n<body>Upstream failed\u0000\u202e\u2028\u2029\t${'🦕'.repeat(6_000)}\nEND_UPSTREAM_BODY`;

function sseResponse(event: unknown) {
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 77));
      controller.enqueue(bytes.slice(77));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

describe('streamed inference error display boundary', () => {
  it.each(['message', 'fallback', 'transport'] as const)('bounds %s errors before authored persistence and follow-up model context', async (source) => {
    vi.stubGlobal('fetch', source === 'transport'
      ? vi.fn().mockRejectedValue(new Error(raw))
      : vi.fn().mockResolvedValue(sseResponse({ error: source === 'message' ? { message: raw } : { detail: raw } })));

    const result = await processStreamWithTimeout(streamChat(options), vi.fn());
    expect(result.error).toBeDefined();
    expect(Array.from(result.error!)).toHaveLength(FAILURE_DETAIL_CHARS + 1);
    expect(result.error).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(result.error).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(result.error!.endsWith('…')).toBe(true);
    expect(result.error).not.toContain('END_UPSTREAM_BODY');
    expect(result.toolCalls).toEqual([]);

    // These are the final assistant shapes used by sendMessage and by the
    // confirmed-action inference follow-up. Both mark saved errors authored.
    const messages: ChatMessage[] = [
      { id: 'user', role: 'user', content: 'Check my app', timestamp: 1 },
      { id: 'chat-error', role: 'assistant', content: result.content, error: result.error, timestamp: 2 },
      { id: 'follow-up-error', role: 'assistant', content: `Error: ${result.error}`, error: result.error, timestamp: 3 },
    ];
    saveHistory(identity, messages, true);
    const saved = JSON.parse(localStorage.getItem(historyStorageKey(identity))!).data.messages;
    expect(saved[1]).toMatchObject({ errorFormat: 'authored', error: result.error });
    expect(saved[2]).toMatchObject({ errorFormat: 'authored', error: result.error });
    const restored = loadHistory(identity);
    expect(restored[1].error).toBe(result.error);
    expect(restored[2].error).toBe(result.error);
    expect(restored[2]).not.toHaveProperty('errorFormat');
    const wire = serializeMessagesForApi(toChatApiMessages(restored, identity.address));
    expect(wire.at(-1)).toMatchObject({ role: 'assistant', content: `Error: ${result.error}` });
    expect(JSON.stringify(wire)).not.toContain('END_UPSTREAM_BODY');
  });

  it('preserves successful multiline stream content beyond the error-detail cap', async () => {
    const content = `First line\n  indented second line\n${'🦕'.repeat(600)}\nLast line`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse({ choices: [{ delta: { content }, finish_reason: 'stop' }] })));
    const result = await processStreamWithTimeout(streamChat(options), vi.fn());
    expect(result.error).toBeUndefined();
    expect(result.content).toBe(content);
  });
});
