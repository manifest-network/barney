/**
 * AI Streaming Client
 * OpenAI-compatible SSE streaming client for chat completions APIs.
 * All requests go through the /api/morpheus/ proxy which injects auth server-side.
 */

import { logError } from '../utils/errors';
import { HEALTH_CHECK_TIMEOUT_MS, AI_STREAM_TIMEOUT_MS } from '../config/constants';
import { runtimeConfig } from '../config/runtimeConfig';
import {
  fetchWithMorpheusSession,
  MorpheusRequestTimeoutError,
  type MorpheusAuthContext,
} from './morpheusSession';

const RELAY_PROMPT_CHAR_BUDGET = 100_000;
const RELAY_CONTEXT_BYTE_BUDGET = 320 * 1024;

export interface ChatApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, {
        type: string;
        description?: string;
        enum?: string[];
        items?: { type: string };
      }>;
      required?: string[];
    };
  };
}

export interface StreamChatOptions {
  messages: ChatApiMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  auth?: MorpheusAuthContext;
}

/**
 * Discriminated union for stream chunks.
 * Each variant has a specific type and the corresponding payload fields.
 */
export type StreamChunk =
  | { type: 'content'; content: string }
  | { type: 'thinking'; content: string } // Reserved for models that emit chain-of-thought reasoning (not currently used by Morpheus)
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'done' }
  | { type: 'error'; error: string };

/**
 * Serialize messages for the OpenAI-compatible API.
 * Converts ToolCall.function.arguments from Record<string, unknown> to JSON strings
 * as required by the OpenAI chat completions format.
 */
export function serializeMessagesForApi(messages: ChatApiMessage[]): unknown[] {
  return messages.map((msg) => {
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg;
    }
    return {
      ...msg,
      tool_calls: msg.tool_calls.map((tc) => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: typeof tc.function.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments),
        },
      })),
    };
  });
}

/**
 * Keep local history for the UI while sending only a bounded recent suffix to
 * the paid relay. This prevents an oversized tool/log result from wedging every
 * later turn. The system prompt and newest turn are retained; a terminal
 * assistant/tool exchange is kept as one protocol-valid unit, and orphaned
 * leading tool responses are removed.
 */
export function compactMessagesForRelay(
  messages: ChatApiMessage[],
  tools: ToolDefinition[] = [],
): ChatApiMessage[] {
  const serializedMessages = serializeMessagesForApi(messages);
  const encoder = new TextEncoder();
  const promptChars = messages.map(
    (message) => (typeof message.content === 'string' ? message.content.length : 0),
  );
  const encodedMessageBytes = serializedMessages.map(
    (message) => encoder.encode(JSON.stringify(message)).byteLength,
  );
  let retainedPromptChars = promptChars.reduce((total, size) => total + size, 0);
  let retainedContextBytes = encoder.encode(JSON.stringify({
    messages: serializedMessages,
    tools,
  })).byteLength;
  const firstConversationIndex = messages[0]?.role === 'system' ? 1 : 0;
  const newestIndex = messages.length - 1;
  let firstRetainedIndex = firstConversationIndex;
  let protectedSuffixIndex = newestIndex;

  if (messages[newestIndex]?.role === 'tool') {
    let terminalToolIndex = newestIndex;
    while (terminalToolIndex > firstConversationIndex
      && messages[terminalToolIndex - 1]?.role === 'tool') {
      terminalToolIndex -= 1;
    }
    const assistantIndex = terminalToolIndex - 1;
    const assistant = messages[assistantIndex];
    const toolCallIds = new Set(assistant?.tool_calls?.map((toolCall) => toolCall.id));
    const terminalToolsMatch = assistant?.role === 'assistant'
      && toolCallIds.size > 0
      && messages.slice(terminalToolIndex).every(
        (message) => message.role === 'tool'
          && typeof message.tool_call_id === 'string'
          && toolCallIds.has(message.tool_call_id),
      );
    if (terminalToolsMatch) protectedSuffixIndex = assistantIndex;
  }

  const overBudget = () => retainedPromptChars > RELAY_PROMPT_CHAR_BUDGET
    || retainedContextBytes > RELAY_CONTEXT_BYTE_BUDGET;
  const removeNext = () => {
    retainedPromptChars -= promptChars[firstRetainedIndex];
    // A non-empty suffix is always protected, so removing any earlier array
    // element also removes exactly one comma from the serialized JSON array.
    retainedContextBytes -= encodedMessageBytes[firstRetainedIndex] + 1;
    firstRetainedIndex += 1;
  };

  while (overBudget() && firstRetainedIndex < protectedSuffixIndex) {
    removeNext();
    while (firstRetainedIndex < protectedSuffixIndex
      && messages[firstRetainedIndex]?.role === 'tool') {
      removeNext();
    }
  }

  // Malformed/local history can still end in a tool result without its matching
  // assistant call. Never send that orphan as the first conversation message.
  while (messages[firstRetainedIndex]?.role === 'tool') firstRetainedIndex += 1;

  return firstConversationIndex === 1
    ? [messages[0], ...messages.slice(firstRetainedIndex)]
    : messages.slice(firstRetainedIndex);
}

/** Accumulated state for a single tool call being streamed incrementally. */
interface PartialToolCall {
  id: string;
  type: 'function';
  functionName: string;
  argumentFragments: string;
}

/**
 * Parse SSE stream from an OpenAI-compatible API.
 */
async function* parseSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by double newlines
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      for (const line of part.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          try {
            yield JSON.parse(data);
          } catch (error) {
            logError('chatApi.parseSSE', error);
          }
        }
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;

      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          yield JSON.parse(data);
        } catch (error) {
          logError('chatApi.parseSSE', error);
        }
      }
    }
  }
}

/**
 * Stream chat completion from an OpenAI-compatible API.
 * Requests go through /api/morpheus/ proxy (auth injected server-side).
 */
export async function* streamChat(
  options: StreamChatOptions
): AsyncGenerator<StreamChunk> {
  const { messages, tools, signal, auth } = options;
  const model = runtimeConfig.PUBLIC_MORPHEUS_MODEL;

  if (!auth) {
    yield { type: 'error', error: 'Connect a wallet that supports message signing before using AI chat.' };
    return;
  }

  const requestMessages = compactMessagesForRelay(messages, tools);
  if (!requestMessages.some((message) => message.role !== 'system')) {
    yield {
      type: 'error',
      error: 'The current conversation is missing the tool context required for inference. Start a new chat or resend your request.',
    };
    return;
  }
  const body: Record<string, unknown> = {
    model,
    messages: serializeMessagesForApi(requestMessages),
    stream: true,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  // Accumulate tool calls streamed incrementally by index
  const partialToolCalls: Map<number, PartialToolCall> = new Map();

  try {
    const response = await fetchWithMorpheusSession(auth, '/api/morpheus/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }, AI_STREAM_TIMEOUT_MS);

    if (!response.ok) {
      yield {
        type: 'error',
        error: response.status === 413
          ? 'The current request is too large for inference. Start a new chat or shorten the latest message.'
          : response.status === 429
            ? 'The inference quota or concurrency limit has been reached. Try again later.'
            : 'The inference service is temporarily unavailable.',
      };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body from AI API' };
      return;
    }

    const reader = response.body.getReader();

    for await (const chunk of parseSSE(reader)) {
      // Handle SSE-level error objects (e.g. {"error": {"message": "..."}})
      const chunkError = chunk.error as Record<string, unknown> | undefined;
      if (chunkError) {
        const errorMsg = typeof chunkError.message === 'string'
          ? chunkError.message
          : JSON.stringify(chunkError);
        yield { type: 'error', error: errorMsg };
        return;
      }

      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      if (!choices || choices.length === 0) continue;

      const choice = choices[0];
      const delta = choice.delta as Record<string, unknown> | undefined;
      const finishReason = choice.finish_reason as string | null | undefined;

      if (delta) {
        // Handle content
        if (typeof delta.content === 'string' && delta.content) {
          yield { type: 'content', content: delta.content };
        }

        // Handle incremental tool calls
        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (!tc || typeof tc !== 'object') continue;

            const tcObj = tc as Record<string, unknown>;
            const index = typeof tcObj.index === 'number' ? tcObj.index : 0;

            let partial = partialToolCalls.get(index);
            if (!partial) {
              const tcId = typeof tcObj.id === 'string' ? tcObj.id : crypto.randomUUID();
              partial = {
                id: tcId,
                type: 'function',
                functionName: '',
                argumentFragments: '',
              };
              partialToolCalls.set(index, partial);
            }

            // Accumulate function name and arguments from each chunk
            const tcFunc = tcObj.function as Record<string, unknown> | undefined;
            if (tcFunc) {
              if (typeof tcFunc.name === 'string' && tcFunc.name) {
                partial.functionName += tcFunc.name;
              }
              if (typeof tcFunc.arguments === 'string') {
                partial.argumentFragments += tcFunc.arguments;
              }
            }
          }
        }
      }

      // Emit completed tool calls on finish_reason: "tool_calls" or "stop"
      if (finishReason === 'tool_calls' || (finishReason === 'stop' && partialToolCalls.size > 0)) {
        yield* emitToolCalls(partialToolCalls);
      }

      if (finishReason === 'stop' || finishReason === 'tool_calls') {
        yield { type: 'done' };
        return;
      }
    }

    // Stream ended without explicit finish_reason — emit any accumulated tool calls
    if (partialToolCalls.size > 0) {
      yield* emitToolCalls(partialToolCalls);
    }

    yield { type: 'done' };
  } catch (error) {
    if (error instanceof MorpheusRequestTimeoutError) {
      yield { type: 'error', error: 'Connection to AI API timed out.' };
      return;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      if (signal?.aborted) {
        yield { type: 'done' };
      } else {
        yield { type: 'error', error: 'Connection to AI API timed out.' };
      }
      return;
    }
    yield {
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Emit accumulated partial tool calls as complete ToolCall chunks.
 */
function* emitToolCalls(
  partialToolCalls: Map<number, PartialToolCall>
): Generator<StreamChunk> {
  const sortedEntries = [...partialToolCalls.entries()].sort((a, b) => a[0] - b[0]);

  for (const [, partial] of sortedEntries) {
    if (!partial.functionName) continue;

    let args: Record<string, unknown> = {};
    if (partial.argumentFragments) {
      try {
        args = JSON.parse(partial.argumentFragments);
      } catch (error) {
        logError('chatApi.parseToolArgs', error);
      }
    }

    const toolCall: ToolCall = {
      id: partial.id,
      type: 'function',
      function: {
        name: partial.functionName,
        arguments: args,
      },
    };
    yield { type: 'tool_call', toolCall };
  }

  partialToolCalls.clear();
}

/**
 * Check if the AI API is available.
 * GET the relay readiness endpoint. The relay caches a bounded provider-model
 * probe and also reports ledger health and hard-budget availability.
 */
export async function checkApiHealth(): Promise<boolean> {
  try {
    const response = await fetch('/api/morpheus/readyz', {
      method: 'GET',
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    return response.ok;
  } catch (error) {
    logError('chatApi.checkApiHealth', error);
    return false;
  }
}
