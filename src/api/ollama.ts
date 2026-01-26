/**
 * Ollama Streaming Client
 * Handles communication with Ollama API for LLM inference
 */

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

export interface OllamaStreamChunk {
  type: 'content' | 'thinking' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: OllamaToolCall;
  error?: string;
}

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
        } catch {
          // Skip invalid JSON lines
        }
      }
    }
  }

  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer);
    } catch {
      // Skip invalid JSON
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
    const response = await fetch(`${endpoint}/api/chat`, {
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
            const toolCall: OllamaToolCall = {
              id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
              type: 'function',
              function: {
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || {},
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
 * Fetch available models from Ollama
 */
export async function listModels(endpoint: string): Promise<OllamaModel[]> {
  try {
    const response = await fetch(`${endpoint}/api/tags`);
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }
    const data = await response.json();
    return data.models || [];
  } catch (error) {
    console.error('Failed to list Ollama models:', error);
    return [];
  }
}

/**
 * Check if Ollama is available at the given endpoint
 */
export async function checkOllamaHealth(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
