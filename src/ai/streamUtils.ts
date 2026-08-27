/**
 * Stream processing utilities for AI chat streaming.
 * Pure functions — no React hooks or state.
 */

import type { StreamChunk, ToolCall } from '../api/morpheus';
import { AI_STREAM_INITIAL_TIMEOUT_MS, AI_STREAM_TIMEOUT_MS } from '../config/constants';

export interface StreamResult {
  content: string;
  thinking: string;
  toolCalls: ToolCall[];
  error?: string;
}

/**
 * Strip raw tool-call leaks that some models emit as literal text
 * instead of using the structured tool_calls field.
 *
 * Legacy safeguard from the Ollama/Mistral era — kept as defensive code
 * for the Morpheus API in case upstream models regress to this behavior.
 *
 * Handles:
 *  - Paired: `[TOOL_CALLS]...json...[TOOL_CALLS]`
 *  - Single prefix + JSON block: `[TOOL_CALLS][{...}]` or `[TOOL_CALLS]{"..."}`
 *  - Bare marker with no content
 */
export function stripToolCallLeaks(text: string): string {
  // Fast path: the `[TOOL_CALLS]` marker almost never appears, so avoid the four
  // backtracking regex passes over the whole accumulated buffer on every stream
  // chunk. With no marker present, the four no-op `.replace()`s followed by
  // `.trim()` produce exactly `text.trim()` — so this is behavior-identical.
  if (text.indexOf('[TOOL_CALLS]') === -1) {
    return text.trim();
  }
  return text
    .replace(/\[TOOL_CALLS\][\s\S]*?\[TOOL_CALLS\]/g, '')
    .replace(/\[TOOL_CALLS\]\s*\[[\s\S]*?\]\s*/g, '')
    .replace(/\[TOOL_CALLS\]\s*\{[\s\S]*?\}\s*/g, '')
    .replace(/\[TOOL_CALLS\]/g, '')
    .trim();
}

/**
 * Wrap an async generator with timeout protection per iteration. The first
 * iteration gets a separate wallet-authentication allowance because invoking
 * streamChat does not start its async body until the first next() call.
 */
async function* withTimeout<T>(
  generator: AsyncGenerator<T>,
  timeoutMs: number,
  initialTimeoutMs: number,
): AsyncGenerator<T> {
  let firstIteration = true;
  let timedOut = false;
  try {
    while (true) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      try {
        const result = await Promise.race([
          generator.next(),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => {
                timedOut = true;
                reject(new Error(firstIteration
                  ? 'Session timeout: wallet authentication or the initial AI response took too long'
                  : 'Stream timeout: no response received'));
              },
              firstIteration ? initialTimeoutMs : timeoutMs,
            );
          }),
        ]);

        if (result.done) break;
        firstIteration = false;
        yield result.value;
      } finally {
        // Clear the timeout to avoid accumulating orphan timers
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    }
  } finally {
    // Normal early exits await cleanup. On timeout, return() can itself wait for
    // the pending next() (notably a wallet signing promise), which would prevent
    // the timeout from reaching the caller and its AbortController. Let the
    // caller abort first; the queued return still closes the generator when that
    // pending step observes the signal.
    const cleanup = generator.return(undefined as T);
    if (timedOut) void cleanup.catch(() => {});
    else await cleanup;
  }
}

/**
 * Process stream chunks with timeout protection. The initial iteration includes
 * wallet authentication and uses initialTimeoutMs; later chunks use timeoutMs.
 */
export async function processStreamWithTimeout(
  stream: AsyncGenerator<StreamChunk>,
  onChunk: (content: string, thinking: string) => void,
  timeoutMs: number = AI_STREAM_TIMEOUT_MS,
  initialTimeoutMs: number = AI_STREAM_INITIAL_TIMEOUT_MS,
): Promise<StreamResult> {
  let accumulatedContent = '';
  let accumulatedThinking = '';
  const toolCalls: ToolCall[] = [];

  for await (const chunk of withTimeout(stream, timeoutMs, initialTimeoutMs)) {
    if (chunk.type === 'thinking' && chunk.content) {
      accumulatedThinking += chunk.content;
      onChunk(stripToolCallLeaks(accumulatedContent), accumulatedThinking);
    } else if (chunk.type === 'content' && chunk.content) {
      accumulatedContent += chunk.content;
      onChunk(stripToolCallLeaks(accumulatedContent), accumulatedThinking);
    } else if (chunk.type === 'tool_call' && chunk.toolCall) {
      toolCalls.push(chunk.toolCall);
    } else if (chunk.type === 'error') {
      return {
        content: stripToolCallLeaks(accumulatedContent),
        thinking: accumulatedThinking,
        toolCalls,
        error: chunk.error,
      };
    }
  }

  return { content: stripToolCallLeaks(accumulatedContent), thinking: accumulatedThinking, toolCalls };
}
