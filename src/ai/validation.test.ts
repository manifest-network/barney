import { describe, it, expect } from 'vitest';
import {
  validateEndpointUrl,
  validateSettings,
  validateChatHistory,
  sanitizeToolArgs,
  validateUserInput,
  isPrivateHost,
  MAX_INPUT_LENGTH,
} from './validation';

describe('validateEndpointUrl', () => {
  it('accepts valid public http URLs', () => {
    expect(validateEndpointUrl('http://example.com')).toBe('http://example.com');
    expect(validateEndpointUrl('http://ollama.example.com:11434')).toBe('http://ollama.example.com:11434');
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
    expect(validateEndpointUrl('https://api.example.com/api/generate')).toBe('https://api.example.com');
  });

  // Note: In development mode (import.meta.env.DEV === true), private hosts are allowed
  // The isPrivateHost function is tested separately below
});

describe('isPrivateHost (SSRF protection via ipaddr.js)', () => {
  it('identifies localhost as private', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('LOCALHOST')).toBe(true);
    expect(isPrivateHost('localhost.localdomain')).toBe(true);
  });

  it('identifies IPv6 localhost as private', () => {
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('[::1]')).toBe(true);
  });

  it('identifies cloud metadata endpoint as private (link-local)', () => {
    // 169.254.169.254 is the AWS/GCP/Azure metadata endpoint
    expect(isPrivateHost('169.254.169.254')).toBe(true);
    expect(isPrivateHost('169.254.0.1')).toBe(true);
  });

  it('identifies 10.x.x.x private range', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('10.255.255.255')).toBe(true);
  });

  it('identifies 172.16-31.x.x private range', () => {
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    // 172.15.x.x and 172.32.x.x are NOT private
    expect(isPrivateHost('172.15.0.1')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
  });

  it('identifies 192.168.x.x private range', () => {
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('192.168.0.100')).toBe(true);
  });

  it('identifies loopback addresses', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('127.0.0.2')).toBe(true);
    expect(isPrivateHost('127.255.255.255')).toBe(true);
  });

  it('identifies internal domain patterns', () => {
    expect(isPrivateHost('server.local')).toBe(true);
    expect(isPrivateHost('app.internal')).toBe(true);
    expect(isPrivateHost('host.localdomain')).toBe(true);
  });

  it('allows public IP addresses', () => {
    expect(isPrivateHost('8.8.8.8')).toBe(false); // Google DNS
    expect(isPrivateHost('1.1.1.1')).toBe(false); // Cloudflare DNS
    expect(isPrivateHost('93.184.216.34')).toBe(false); // example.com
  });

  it('allows public domain names', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('api.ollama.com')).toBe(false);
    expect(isPrivateHost('ollama.example.org')).toBe(false);
  });

  it('blocks multicast and reserved ranges', () => {
    expect(isPrivateHost('224.0.0.1')).toBe(true); // Multicast
    expect(isPrivateHost('240.0.0.1')).toBe(true); // Reserved
    expect(isPrivateHost('0.0.0.0')).toBe(true); // Unspecified
  });

  // ipaddr.js handles unusual IP formats that could bypass naive validation
  it('handles octal IP notation (SSRF bypass prevention)', () => {
    // 0177.0.0.1 is octal for 127.0.0.1
    expect(isPrivateHost('0177.0.0.1')).toBe(true);
  });

  it('handles IPv6 private ranges', () => {
    expect(isPrivateHost('fc00::1')).toBe(true); // Unique local
    expect(isPrivateHost('fe80::1')).toBe(true); // Link-local
    expect(isPrivateHost('ff02::1')).toBe(true); // Multicast
  });

  it('allows non-IP hostnames (DNS resolution happens later)', () => {
    // Invalid IPs that aren't valid hostnames are allowed through
    // (they'll fail at DNS resolution)
    expect(isPrivateHost('not-an-ip')).toBe(false);
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

  it('validates valid settings with public URL', () => {
    const input = {
      ollamaEndpoint: 'https://ollama.example.com:8080',
      model: 'llama3.1',
      saveHistory: false,
      enableThinking: true,
    };
    const result = validateSettings(input);
    expect(result.ollamaEndpoint).toBe('https://ollama.example.com:8080');
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

  // Note: SSRF protection for validateSettings is tested via isPrivateHost.
  // In dev mode, private IPs are allowed to enable local Ollama usage.
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
