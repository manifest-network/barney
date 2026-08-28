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
  return promptChars;
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
  if (Array.isArray(body.tools) && body.tools.some((tool) => !isObject(tool))) {
    throw new RequestError(400, 'tools_invalid', 'Each tool must be an object');
  }
  if (body.temperature !== undefined
    && (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) {
    throw new RequestError(400, 'temperature_invalid', 'temperature must be between 0 and 2');
  }
  if (body.top_p !== undefined
    && (typeof body.top_p !== 'number' || !Number.isFinite(body.top_p) || body.top_p < 0 || body.top_p > 1)) {
    throw new RequestError(400, 'top_p_invalid', 'top_p must be between 0 and 1');
  }
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') {
    throw new RequestError(400, 'parallel_tool_calls_invalid', 'parallel_tool_calls must be a boolean');
  }
  if (body.response_format !== undefined && !isObject(body.response_format)) {
    throw new RequestError(400, 'response_format_invalid', 'response_format must be an object');
  }
  if (body.tool_choice !== undefined && typeof body.tool_choice !== 'string' && !isObject(body.tool_choice)) {
    throw new RequestError(400, 'tool_choice_invalid', 'tool_choice must be a string or object');
  }
  if (body.stop !== undefined) {
    const stops = typeof body.stop === 'string' ? [body.stop] : body.stop;
    if (!Array.isArray(stops) || stops.length > 4
      || stops.some((stop) => typeof stop !== 'string' || stop.length > 1_024)) {
      throw new RequestError(400, 'stop_invalid', 'stop must contain at most four bounded strings');
    }
  }
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) {
    throw new RequestError(400, 'output_limit_invalid', 'Specify only one output-token limit');
  }
  const requestedOutput = body.max_completion_tokens ?? body.max_tokens ?? config.maxOutputTokens;
  if (!positiveOutputTokens(requestedOutput)) {
    throw new RequestError(400, 'output_limit_invalid', 'Output-token limit must be a positive integer');
  }
  const outputTokens = Math.min(requestedOutput, config.maxOutputTokens);

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

  // Measure the exact rebuilt request rather than a subset of its fields. This
  // includes response_format, stop, tool_choice, and every other value that is
  // actually forwarded. The byte ceiling is unambiguous and tokenizer-free.
  const contextBytes = Buffer.byteLength(JSON.stringify(upstream), 'utf8');
  if (contextBytes > config.maxContextBytes) {
    throw new RequestError(413, 'context_too_large', 'Prompt and tool context exceed the configured byte limit');
  }
  const recordOverhead = body.messages.length * 4 + (body.tools?.length ?? 0) * 8;
  const inputTokens = Math.ceil(contextBytes / config.estimatedBytesPerToken) + recordOverhead;
  // A byte-level tokenizer cannot emit more tokens than input bytes; retain a
  // small per-record allowance for provider-injected chat delimiters.
  const worstCaseInputTokens = contextBytes
    + body.messages.length * 16
    + (body.tools?.length ?? 0) * 32;

  return { upstream, inputTokens, worstCaseInputTokens, outputTokens, contextBytes };
}
