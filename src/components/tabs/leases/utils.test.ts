import { describe, it, expect } from 'vitest';
import { validateSignMessage, formatKey } from './utils';

describe('validateSignMessage', () => {
  it('accepts a valid message with expected prefix', () => {
    expect(validateSignMessage('auth:abc123', 'auth:')).toBe(true);
  });

  it('rejects message missing the expected prefix', () => {
    expect(validateSignMessage('wrong:abc123', 'auth:')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateSignMessage('', 'auth:')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(validateSignMessage(null as unknown as string, 'auth:')).toBe(false);
    expect(validateSignMessage(undefined as unknown as string, 'auth:')).toBe(false);
  });

  it('rejects message with unsafe characters', () => {
    expect(validateSignMessage('auth:<script>', 'auth:')).toBe(false);
    expect(validateSignMessage('auth:abc/def', 'auth:')).toBe(false);
    expect(validateSignMessage('auth:abc@def', 'auth:')).toBe(false);
  });

  it('accepts message with allowed characters (alphanumeric, spaces, colons, hyphens)', () => {
    expect(validateSignMessage('auth:abc-123 test:value', 'auth:')).toBe(true);
  });
});

describe('formatKey', () => {
  it('formats snake_case keys', () => {
    expect(formatKey('lease_uuid')).toBe('Lease Uuid');
  });

  it('formats camelCase keys', () => {
    expect(formatKey('leaseUuid')).toBe('Lease Uuid');
  });

  it('formats single word', () => {
    expect(formatKey('status')).toBe('Status');
  });

  it('formats mixed snake_case and camelCase', () => {
    expect(formatKey('provider_apiUrl')).toBe('Provider Api Url');
  });

  it('handles already-spaced input', () => {
    expect(formatKey('lease uuid')).toBe('Lease Uuid');
  });
});
