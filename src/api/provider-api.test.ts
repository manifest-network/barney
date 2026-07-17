import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
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
// Tests below cover Barney-specific behavior: null-return health check.

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
