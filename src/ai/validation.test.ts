import { describe, it, expect } from 'vitest';
import {
  validateEndpointUrl,
  validateSettings,
  validateChatHistory,
  sanitizeToolArgs,
  validateUserInput,
  MAX_INPUT_LENGTH,
} from './validation';

describe('validateEndpointUrl', () => {
  it('accepts valid http URLs', () => {
    expect(validateEndpointUrl('http://localhost:11434')).toBe('http://localhost:11434');
    expect(validateEndpointUrl('http://example.com')).toBe('http://example.com');
  });

  it('accepts valid https URLs', () => {
    expect(validateEndpointUrl('https://api.example.com')).toBe('https://api.example.com');
  });

  it('rejects non-http(s) protocols', () => {
    expect(validateEndpointUrl('ftp://example.com')).toBeNull();
    expect(validateEndpointUrl('file:///etc/passwd')).toBeNull();
  });

  it('rejects URLs with credentials', () => {
    expect(validateEndpointUrl('http://user:pass@example.com')).toBeNull();
  });

  it('rejects empty/invalid URLs', () => {
    expect(validateEndpointUrl('')).toBeNull();
    expect(validateEndpointUrl('not a url')).toBeNull();
  });

  it('rejects URLs that are too long', () => {
    const longUrl = 'http://example.com/' + 'a'.repeat(2100);
    expect(validateEndpointUrl(longUrl)).toBeNull();
  });

  it('strips paths and returns origin', () => {
    expect(validateEndpointUrl('http://localhost:11434/api/generate')).toBe('http://localhost:11434');
  });
});

describe('validateSettings', () => {
  it('returns defaults for null/undefined', () => {
    const defaults = validateSettings(null);
    expect(defaults.ollamaEndpoint).toBe('http://localhost:11434');
    expect(defaults.model).toBe('llama3.2');
    expect(defaults.saveHistory).toBe(true);
    expect(defaults.enableThinking).toBe(false);
  });

  it('validates valid settings', () => {
    const input = {
      ollamaEndpoint: 'http://custom:8080',
      model: 'llama3.1',
      saveHistory: false,
      enableThinking: true,
    };
    const result = validateSettings(input);
    expect(result.ollamaEndpoint).toBe('http://custom:8080');
    expect(result.model).toBe('llama3.1');
    expect(result.saveHistory).toBe(false);
    expect(result.enableThinking).toBe(true);
  });

  it('uses defaults for invalid fields', () => {
    const input = {
      ollamaEndpoint: 'invalid-url',
      model: '',
      saveHistory: 'not-a-boolean',
    };
    const result = validateSettings(input);
    expect(result.ollamaEndpoint).toBe('http://localhost:11434');
    expect(result.model).toBe('llama3.2');
    expect(result.saveHistory).toBe(true);
  });

  it('rejects model names with invalid characters', () => {
    const input = {
      model: 'model<script>',
    };
    const result = validateSettings(input);
    expect(result.model).toBe('llama3.2'); // defaults
  });
});

describe('validateChatHistory', () => {
  it('returns empty array for non-array', () => {
    expect(validateChatHistory(null)).toEqual([]);
    expect(validateChatHistory('string')).toEqual([]);
    expect(validateChatHistory({})).toEqual([]);
  });

  it('validates correct messages', () => {
    const messages = [
      {
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      },
      {
        id: 'msg-2',
        role: 'assistant',
        content: 'Hi there!',
        timestamp: Date.now(),
      },
    ];
    const result = validateChatHistory(messages);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
  });

  it('filters out invalid messages', () => {
    const messages = [
      { id: 'valid', role: 'user', content: 'Hello', timestamp: 123 },
      { id: '', role: 'user', content: 'Invalid id', timestamp: 123 },
      { id: 'valid2', role: 'invalid-role', content: 'Bad role', timestamp: 123 },
      { id: 'valid3', role: 'user', content: 'Valid', timestamp: 'not-a-number' },
    ];
    const result = validateChatHistory(messages);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('valid');
  });

  it('resets isStreaming to false', () => {
    const messages = [
      { id: '1', role: 'assistant', content: 'Test', timestamp: 123, isStreaming: true },
    ];
    const result = validateChatHistory(messages);
    expect(result[0].isStreaming).toBe(false);
  });

  it('limits message count', () => {
    const messages = Array.from({ length: 200 }, (_, i) => ({
      id: `msg-${i}`,
      role: 'user' as const,
      content: `Message ${i}`,
      timestamp: i,
    }));
    const result = validateChatHistory(messages);
    expect(result.length).toBeLessThanOrEqual(100);
  });
});

describe('sanitizeToolArgs', () => {
  it('returns empty object for non-objects', () => {
    expect(sanitizeToolArgs(null)).toEqual({});
    expect(sanitizeToolArgs('string')).toEqual({});
    expect(sanitizeToolArgs([])).toEqual({});
    expect(sanitizeToolArgs(123)).toEqual({});
  });

  it('passes through valid args', () => {
    const args = { key: 'value', count: 42 };
    expect(sanitizeToolArgs(args)).toEqual(args);
  });

  it('strips prototype pollution vectors', () => {
    const args = {
      __proto__: { malicious: true },
      constructor: 'bad',
      prototype: 'evil',
      normalKey: 'safe',
    };
    const result = sanitizeToolArgs(args);
    // Check that dangerous keys are not own properties of the result
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
    expect(result.normalKey).toBe('safe');
  });
});

describe('validateUserInput', () => {
  it('validates normal input', () => {
    expect(validateUserInput('Hello world')).toBe('Hello world');
  });

  it('trims whitespace', () => {
    expect(validateUserInput('  hello  ')).toBe('hello');
  });

  it('rejects empty input', () => {
    expect(validateUserInput('')).toBeNull();
    expect(validateUserInput('   ')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(validateUserInput(null as unknown as string)).toBeNull();
    expect(validateUserInput(123 as unknown as string)).toBeNull();
  });

  it('rejects input exceeding max length', () => {
    const tooLong = 'x'.repeat(MAX_INPUT_LENGTH + 1);
    expect(validateUserInput(tooLong)).toBeNull();
  });

  it('accepts input at max length', () => {
    const maxLength = 'x'.repeat(MAX_INPUT_LENGTH);
    expect(validateUserInput(maxLength)).toBe(maxLength);
  });
});
