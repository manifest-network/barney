import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateAuthTimestamp,
  getProviderHealth,
} from './provider-api';

// Mock url utilities to allow test URLs through SSRF check
vi.mock('../utils/url', () => ({
  parseHttpUrl: (url: string) => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  },
  isUrlSsrfSafe: () => true,
}));

vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

// Auth, connection, upload, and ProviderApiError tests are in mono's test suite.
// Tests below cover Barney-specific behavior: timestamp validation and null-return health check.

describe('validateAuthTimestamp', () => {
  it('accepts current timestamp', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() => validateAuthTimestamp(now)).not.toThrow();
  });

  it('accepts timestamp 30 seconds ago', () => {
    const thirtySecAgo = Math.floor(Date.now() / 1000) - 30;
    expect(() => validateAuthTimestamp(thirtySecAgo)).not.toThrow();
  });

  it('rejects timestamp 90 seconds ago', () => {
    const ninetySecAgo = Math.floor(Date.now() / 1000) - 90;
    expect(() => validateAuthTimestamp(ninetySecAgo)).toThrow('expired');
  });

  it('rejects timestamp 15 seconds in the future', () => {
    const fifteenSecFuture = Math.floor(Date.now() / 1000) + 15;
    expect(() => validateAuthTimestamp(fifteenSecFuture)).toThrow('future');
  });

  it('rejects NaN', () => {
    expect(() => validateAuthTimestamp(NaN)).toThrow('finite number');
  });

  it('rejects Infinity', () => {
    expect(() => validateAuthTimestamp(Infinity)).toThrow('finite number');
  });

  it('accepts timestamp exactly 60 seconds ago', () => {
    const exactLimit = Math.floor(Date.now() / 1000) - 60;
    expect(() => validateAuthTimestamp(exactLimit)).not.toThrow();
  });

  it('rejects timestamp 61 seconds ago', () => {
    const justPast = Math.floor(Date.now() / 1000) - 61;
    expect(() => validateAuthTimestamp(justPast)).toThrow('expired');
  });

  it('accepts timestamp exactly 10 seconds in the future', () => {
    const exactFuture = Math.floor(Date.now() / 1000) + 10;
    expect(() => validateAuthTimestamp(exactFuture)).not.toThrow();
  });

  it('rejects timestamp 11 seconds in the future', () => {
    const justFuture = Math.floor(Date.now() / 1000) + 11;
    expect(() => validateAuthTimestamp(justFuture)).toThrow('future');
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
