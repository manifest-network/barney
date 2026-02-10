/**
 * Stream processing utilities for Ollama chat streaming.
 * Pure functions — no React hooks or state.
 */

import type { OllamaStreamChunk, OllamaToolCall } from '../api/ollama';
import { AI_STREAM_TIMEOUT_MS } from '../config/constants';

export interface StreamResult {
  content: string;
  thinking: string;
  toolCalls: OllamaToolCall[];
  error?: string;
}

/**
 * Strip raw tool-call leaks that some Ollama models emit as literal text
 * instead of using the structured tool_calls field.
 *
 * Handles:
 *  - Paired: `[TOOL_CALLS]...json...[TOOL_CALLS]`
 *  - Single prefix + JSON block: `[TOOL_CALLS][{...}]` or `[TOOL_CALLS]{"..."}`
 *  - Bare marker with no content
 */
export function stripToolCallLeaks(text: string): string {
  return text
    .replace(/\[TOOL_CALLS\][\s\S]*?\[TOOL_CALLS\]/g, '')
    .replace(/\[TOOL_CALLS\]\s*[[{][\s\S]*?[\]}]\s*/g, '')
    .replace(/\[TOOL_CALLS\]/g, '')
    .trim();
}

/**
 * Wrap an async generator with timeout protection per iteration
 */
async function* withTimeout<T>(
  generator: AsyncGenerator<T>,
  timeoutMs: number
): AsyncGenerator<T> {
  try {
    while (true) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      try {
        const result = await Promise.race([
          generator.next(),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('Stream timeout: no response received')),
              timeoutMs
            );
          }),
        ]);

        if (result.done) break;
        yield result.value;
      } finally {
        // Clear the timeout to avoid accumulating orphan timers
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    }
  } finally {
    // Ensure the underlying generator is cleaned up on early exit (timeout, break, return)
    // Without this, a timeout rejection exits withTimeout but leaves the inner generator open,
    // potentially leaking HTTP connections.
    await generator.return(undefined as T);
  }
}

/**
 * Process stream chunks with timeout protection.
 * Throws TimeoutError if no chunk received within timeout period.
 */
export async function processStreamWithTimeout(
  stream: AsyncGenerator<OllamaStreamChunk>,
  onChunk: (content: string, thinking: string) => void,
  timeoutMs: number = AI_STREAM_TIMEOUT_MS
): Promise<StreamResult> {
  let accumulatedContent = '';
  let accumulatedThinking = '';
  const toolCalls: OllamaToolCall[] = [];

  for await (const chunk of withTimeout(stream, timeoutMs)) {
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
