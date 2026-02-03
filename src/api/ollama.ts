/**
 * Ollama Streaming Client
 * Handles communication with Ollama API for LLM inference
 */

import { logError } from '../utils/errors';
import { HEALTH_CHECK_TIMEOUT_MS } from '../config/constants';
import { withRetry } from './utils';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

export interface OllamaToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaTool {
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

export interface OllamaStreamOptions {
  endpoint: string;
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  think?: boolean;
  signal?: AbortSignal;
}

/**
 * Discriminated union for Ollama stream chunks.
 * Each variant has a specific type and the corresponding payload fields.
 */
export type OllamaStreamChunk =
  | { type: 'content'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; toolCall: OllamaToolCall }
  | { type: 'done' }
  | { type: 'error'; error: string };

export interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
}

/**
 * Parse NDJSON stream from Ollama
 */
async function* parseNDJSON(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          yield JSON.parse(line);
        } catch (error) {
          // Log but don't crash - allows stream to continue
          logError('ollama.parseNDJSON', error);
        }
      }
    }
  }

  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer);
    } catch (error) {
      // Log but don't crash
      logError('ollama.parseNDJSON', error);
    }
  }
}

/**
 * Stream chat completion from Ollama
 */
export async function* streamChat(
  options: OllamaStreamOptions
): AsyncGenerator<OllamaStreamChunk> {
  const { endpoint, model, messages, tools, think, signal } = options;

  // Validate endpoint URL
  let apiUrl: string;
  try {
    const url = new URL('/api/chat', endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      yield { type: 'error', error: 'Invalid Ollama endpoint: must use http or https protocol' };
      return;
    }
    apiUrl = url.href;
  } catch {
    yield { type: 'error', error: 'Invalid Ollama endpoint URL' };
    return;
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  if (think) {
    body.think = true;
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      yield { type: 'error', error: `Ollama API error: ${response.status} ${errorText}` };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body from Ollama' };
      return;
    }

    const reader = response.body.getReader();

    for await (const chunk of parseNDJSON(reader)) {
      // Check for tool calls in the message
      if (chunk.message && typeof chunk.message === 'object') {
        const message = chunk.message as Record<string, unknown>;

        // Handle tool calls
        if (message.tool_calls && Array.isArray(message.tool_calls)) {
          for (const tc of message.tool_calls) {
            // Guard: ensure tc is a non-null object
            if (!tc || typeof tc !== 'object') {
              continue;
            }

            // Guard: ensure tc.function is a valid object
            const tcFunc = (tc as Record<string, unknown>).function;
            if (!tcFunc || typeof tcFunc !== 'object') {
              continue;
            }

            const funcObj = tcFunc as Record<string, unknown>;

            // Preserve Ollama's tool call ID if present, otherwise generate synthetic
            const tcId = (tc as Record<string, unknown>).id;
            const id = (typeof tcId === 'string' && tcId)
              ? tcId
              : `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

            // Get function name with guard
            const funcName = funcObj.name;
            const name = typeof funcName === 'string' ? funcName : '';

            // Skip if no function name (invalid tool call)
            if (!name) {
              continue;
            }

            // Normalize arguments: parse JSON string if needed, default to {} on failure
            let args: Record<string, unknown> = {};
            const rawArgs = funcObj.arguments;
            if (rawArgs) {
              if (typeof rawArgs === 'string') {
                try {
                  args = JSON.parse(rawArgs);
                } catch (error) {
                  // If JSON parse fails, keep empty object but log the issue
                  logError('ollama.parseToolArgs', error);
                }
              } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
                args = rawArgs as Record<string, unknown>;
              }
            }

            const toolCall: OllamaToolCall = {
              id,
              type: 'function',
              function: {
                name,
                arguments: args,
              },
            };
            yield { type: 'tool_call', toolCall };
          }
        }

        // Handle thinking content (from models that support think mode)
        if (message.thinking && typeof message.thinking === 'string') {
          yield { type: 'thinking', content: message.thinking };
        }

        // Handle content
        if (message.content && typeof message.content === 'string') {
          yield { type: 'content', content: message.content };
        }
      }

      // Check if done
      if (chunk.done === true) {
        yield { type: 'done' };
        return;
      }
    }

    yield { type: 'done' };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      yield { type: 'done' };
      return;
    }
    yield {
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Fetch available models from Ollama.
 * Uses retry logic with exponential backoff for transient network failures.
 *
 * @param endpoint - The Ollama API endpoint URL
 * @returns Array of available models, or empty array on failure
 */
export async function listModels(endpoint: string): Promise<OllamaModel[]> {
  try {
    return await withRetry(async () => {
      const response = await fetch(`${endpoint}/api/tags`);
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }
      const data = await response.json();
      return data.models ?? [];
    });
  } catch (error) {
    logError('ollama.listModels', error);
    return [];
  }
}

/**
 * Check if Ollama is available at the given endpoint.
 * Single attempt with timeout - no retries to keep health checks fast.
 *
 * @param endpoint - The Ollama API endpoint URL
 * @returns true if Ollama is healthy, false otherwise
 */
export async function checkOllamaHealth(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    return response.ok;
  } catch (error) {
    logError('ollama.checkOllamaHealth', error);
    return false;
  }
}
