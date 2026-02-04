import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSignMessage,
  createLeaseDataSignMessage,
  createAuthToken,
  isValidMetaHash,
  ProviderApiError,
  getProviderHealth,
  getLeaseConnectionInfo,
  uploadLeaseData,
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

describe('ProviderApiError', () => {
  it('stores status code and message', () => {
    const error = new ProviderApiError(404, 'Not found');
    expect(error.status).toBe(404);
    expect(error.message).toBe('Not found');
    expect(error.name).toBe('ProviderApiError');
  });

  it('is an instance of Error', () => {
    const error = new ProviderApiError(500, 'Internal');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProviderApiError);
  });
});

// Public URL used in tests to pass SSRF validation
const PROVIDER_URL = 'https://provider.example.com';

describe('getProviderHealth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for empty URL', async () => {
    expect(await getProviderHealth('')).toBeNull();
  });

  it('returns health response for healthy provider', async () => {
    const healthResponse = { status: 'healthy', provider_uuid: 'uuid-1' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(healthResponse), { status: 200 }),
    );

    const result = await getProviderHealth(PROVIDER_URL);
    expect(result).toEqual(healthResponse);
  });

  it('returns null for unhealthy HTTP status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('error', { status: 500 }),
    );

    const result = await getProviderHealth(PROVIDER_URL);
    expect(result).toBeNull();
  });

  it('returns null when response has unexpected shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    );

    const result = await getProviderHealth(PROVIDER_URL);
    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

    const result = await getProviderHealth(PROVIDER_URL);
    expect(result).toBeNull();
  });

  it('returns null for invalid provider URL', async () => {
    const result = await getProviderHealth('not-a-url');
    expect(result).toBeNull();
  });
});

describe('getLeaseConnectionInfo', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns connection response on success', async () => {
    const connectionResponse = {
      lease_uuid: 'uuid-1',
      tenant: 'manifest1abc',
      provider_uuid: 'puuid-1',
      connection: { host: '1.2.3.4' },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(connectionResponse), { status: 200 }),
    );

    const result = await getLeaseConnectionInfo(PROVIDER_URL, 'uuid-1', 'token');
    expect(result).toEqual(connectionResponse);
  });

  it('throws ProviderApiError on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('forbidden', { status: 403 }),
    );

    await expect(getLeaseConnectionInfo(PROVIDER_URL, 'uuid-1', 'token'))
      .rejects.toThrow(ProviderApiError);
  });

  it('throws ProviderApiError when response is not valid JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );

    await expect(getLeaseConnectionInfo(PROVIDER_URL, 'uuid-1', 'token'))
      .rejects.toThrow('Provider returned invalid JSON');
  });

  it('throws for invalid provider URL', async () => {
    await expect(getLeaseConnectionInfo('not-a-url', 'uuid-1', 'token'))
      .rejects.toThrow('Invalid provider API URL');
  });
});

describe('uploadLeaseData', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves on successful upload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    await expect(uploadLeaseData(PROVIDER_URL, 'uuid-1', new Uint8Array([1, 2, 3]), 'token'))
      .resolves.toBeUndefined();
  });

  it('throws ProviderApiError on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('conflict', { status: 409 }),
    );

    await expect(uploadLeaseData(PROVIDER_URL, 'uuid-1', new Uint8Array([1]), 'token'))
      .rejects.toThrow(ProviderApiError);
  });

  it('throws for invalid provider URL', async () => {
    await expect(uploadLeaseData('not-a-url', 'uuid-1', new Uint8Array([1]), 'token'))
      .rejects.toThrow('Invalid provider API URL');
  });
});
