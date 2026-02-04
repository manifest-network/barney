import { describe, it, expect } from 'vitest';
import {
  createSignMessage,
  createLeaseDataSignMessage,
  createAuthToken,
  isValidMetaHash,
} from './provider-api';

describe('createSignMessage', () => {
  it('creates message in tenant:leaseUuid:timestamp format', () => {
    const msg = createSignMessage('manifest1abc', 'uuid-123', 1700000000);
    expect(msg).toBe('manifest1abc:uuid-123:1700000000');
  });

  it('handles empty strings', () => {
    const msg = createSignMessage('', '', 0);
    expect(msg).toBe('::0');
  });
});

describe('createLeaseDataSignMessage', () => {
  it('creates message in expected format', () => {
    const hash = 'a'.repeat(64);
    const msg = createLeaseDataSignMessage('uuid-456', hash, 1700000000);
    expect(msg).toBe(`manifest lease data uuid-456 ${hash} 1700000000`);
  });
});

describe('createAuthToken', () => {
  it('returns a base64-encoded JSON string', () => {
    const token = createAuthToken('manifest1abc', 'uuid-123', 1700000000, 'pubkey==', 'sig==');
    const decoded = JSON.parse(atob(token));

    expect(decoded).toEqual({
      tenant: 'manifest1abc',
      lease_uuid: 'uuid-123',
      timestamp: 1700000000,
      pub_key: 'pubkey==',
      signature: 'sig==',
    });
  });

  it('produces valid base64', () => {
    const token = createAuthToken('t', 'l', 0, 'p', 's');
    expect(() => atob(token)).not.toThrow();
  });
});

describe('createAuthToken with metaHashHex', () => {
  it('includes meta_hash in the token when provided', () => {
    const hash = 'b'.repeat(64);
    const token = createAuthToken('manifest1abc', 'uuid-789', 1700000000, 'pubkey==', 'sig==', hash);
    const decoded = JSON.parse(atob(token));

    expect(decoded).toEqual({
      tenant: 'manifest1abc',
      lease_uuid: 'uuid-789',
      meta_hash: hash,
      timestamp: 1700000000,
      pub_key: 'pubkey==',
      signature: 'sig==',
    });
  });

  it('omits meta_hash from token when not provided', () => {
    const token = createAuthToken('manifest1abc', 'uuid-123', 1700000000, 'pubkey==', 'sig==');
    const decoded = JSON.parse(atob(token));

    expect(decoded).not.toHaveProperty('meta_hash');
  });
});

describe('isValidMetaHash', () => {
  it('accepts valid 64-char lowercase hex', () => {
    expect(isValidMetaHash('a'.repeat(64))).toBe(true);
  });

  it('accepts valid 64-char uppercase hex', () => {
    expect(isValidMetaHash('A'.repeat(64))).toBe(true);
  });

  it('accepts mixed case hex', () => {
    expect(isValidMetaHash('aAbBcCdDeEfF00112233445566778899aAbBcCdDeEfF00112233445566778899')).toBe(true);
  });

  it('rejects strings shorter than 64 chars', () => {
    expect(isValidMetaHash('a'.repeat(63))).toBe(false);
  });

  it('rejects strings longer than 64 chars', () => {
    expect(isValidMetaHash('a'.repeat(65))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidMetaHash('g'.repeat(64))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidMetaHash('')).toBe(false);
  });
});
