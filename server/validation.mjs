export class RequestError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.reason = reason;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireAllowedOrigin(request, config) {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') {
    throw new RequestError(403, 'cross_site', 'Cross-site requests are not allowed');
  }
  const origin = request.headers.origin;
  if (origin && !config.allowedOrigins.has(origin)) {
    throw new RequestError(403, 'origin_denied', 'Request origin is not allowed');
  }
}

export function readJson(request, maxBytes) {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return Promise.reject(new RequestError(415, 'content_type', 'Content-Type must be application/json'));
  }

  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    return Promise.reject(new RequestError(413, 'body_too_large', 'Request body is too large'));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      request.resume();
      reject(error);
    };

    request.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new RequestError(413, 'body_too_large', 'Request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', () => fail(new RequestError(400, 'body_read', 'Could not read request body')));
    request.on('aborted', () => fail(new RequestError(400, 'body_aborted', 'Request body was aborted')));
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const value = JSON.parse(text);
        resolve({ value, bytes });
      } catch {
        reject(new RequestError(400, 'invalid_json', 'Request body must be valid JSON'));
      }
    });
  });
}

const ALLOWED_CHAT_KEYS = new Set([
  'model',
  'messages',
  'stream',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'stop',
  'response_format',
  'parallel_tool_calls',
  'max_tokens',
  'max_completion_tokens',
]);

function positiveOutputTokens(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateMessages(messages, config) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > config.maxMessages) {
    throw new RequestError(400, 'messages_invalid', `messages must contain 1-${config.maxMessages} entries`);
  }
  let promptChars = 0;
  for (const message of messages) {
    if (!isObject(message) || !['system', 'user', 'assistant', 'tool'].includes(message.role)) {
      throw new RequestError(400, 'messages_invalid', 'Each message must have a supported role');
    }
    if (message.content !== null && typeof message.content !== 'string') {
      throw new RequestError(400, 'messages_invalid', 'Message content must be text or null');
    }
    if (typeof message.content === 'string') promptChars += message.content.length;
  }
  if (promptChars > config.maxPromptChars) {
    throw new RequestError(413, 'prompt_too_large', 'Prompt is too large');
  }
}

function copyOptional(source, target, key) {
  if (source[key] !== undefined) target[key] = source[key];
}

/**
 * Validate and rebuild the only paid request shape Barney needs.
 * Unknown keys are rejected rather than forwarded to an operator-funded API.
 */
export function validateChatRequest(body, config) {
  if (!isObject(body)) throw new RequestError(400, 'request_invalid', 'Request body must be an object');
  for (const key of Object.keys(body)) {
    if (!ALLOWED_CHAT_KEYS.has(key)) {
      throw new RequestError(400, 'parameter_denied', `Unsupported chat parameter: ${key}`);
    }
  }
  if (typeof body.model !== 'string' || !config.allowedModels.has(body.model)) {
    throw new RequestError(403, 'model_denied', 'Requested model is not allowed');
  }
  if (body.stream !== true) {
    throw new RequestError(400, 'stream_required', 'Streaming chat completions are required');
  }
  validateMessages(body.messages, config);
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new RequestError(400, 'tools_invalid', 'tools must be an array');
  }
  if (Array.isArray(body.tools) && body.tools.length > 128) {
    throw new RequestError(413, 'tools_too_large', 'Too many tools were supplied');
  }
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) {
    throw new RequestError(400, 'output_limit_invalid', 'Specify only one output-token limit');
  }
  const requestedOutput = body.max_completion_tokens ?? body.max_tokens ?? config.maxOutputTokens;
  if (!positiveOutputTokens(requestedOutput)) {
    throw new RequestError(400, 'output_limit_invalid', 'Output-token limit must be a positive integer');
  }
  const outputTokens = Math.min(requestedOutput, config.maxOutputTokens);

  const contextJson = JSON.stringify({ messages: body.messages, tools: body.tools ?? [] });
  // UTF-8 bytes are a conservative tokenizer-independent upper bound for BPE
  // tokens. Add per-record overhead for provider-injected chat delimiters.
  const inputTokens = Buffer.byteLength(contextJson, 'utf8')
    + body.messages.length * 16
    + (body.tools?.length ?? 0) * 32;
  if (inputTokens > config.maxContextTokens) {
    throw new RequestError(413, 'context_too_large', 'Prompt and tool context exceed the configured token limit');
  }

  const upstream = {
    model: body.model,
    messages: body.messages,
    stream: true,
    max_tokens: outputTokens,
    stream_options: { include_usage: true },
  };
  copyOptional(body, upstream, 'tools');
  copyOptional(body, upstream, 'tool_choice');
  copyOptional(body, upstream, 'temperature');
  copyOptional(body, upstream, 'top_p');
  copyOptional(body, upstream, 'stop');
  copyOptional(body, upstream, 'response_format');
  copyOptional(body, upstream, 'parallel_tool_calls');

  return { upstream, inputTokens, outputTokens };
}
