import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getProviderHealth,
  getLeaseConnectionInfo,
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

// ENG-490: the SDK's provider HTTP fns run `validateProviderUrl(url, { allowLoopback })`
// as their FIRST statement, before `fetchFn` is consulted, so a loopback provider URL is
// rejected outright unless the trailing flag is passed. Barney's dev stack IS localhost,
// so these assert the flag reaches the SDK rather than asserting an argument list — the
// dev /proxy-provider tunnel still carries the request either way.
describe('allowLoopback forwarding (ENG-490)', () => {
  const LOOPBACK_URL = 'http://localhost:8080';
  const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
  const AUTH_TOKEN = 'dG9rZW4=';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lets getProviderHealth reach a loopback provider in DEV', async () => {
    const health = { status: 'healthy', provider_uuid: 'uuid-local' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(health), { status: 200 }));

    expect(await getProviderHealth(LOOPBACK_URL)).toEqual(health);
    // DEV routes through the same-origin CORS proxy; the upstream rides X-Proxy-Target.
    expect(fetchSpy.mock.calls[0][0]).toBe('/proxy-provider/health');
  });

  it('lets getLeaseConnectionInfo reach a loopback provider in DEV', async () => {
    const connection = { lease_uuid: LEASE_UUID, connection: { host: 'localhost' } };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(connection), { status: 200 }));

    expect(await getLeaseConnectionInfo(LOOPBACK_URL, LEASE_UUID, AUTH_TOKEN)).toEqual(
      connection
    );
    expect(fetchSpy.mock.calls[0][0]).toBe(
      `/proxy-provider/v1/leases/${LEASE_UUID}/connection`
    );
  });

  it('still blocks a loopback provider in PROD', async () => {
    vi.stubEnv('DEV', false);
    vi.resetModules(); // ALLOW_LOOPBACK is captured at module eval, so re-import it
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { getProviderHealth: prodGetProviderHealth } = await import('./provider-api');

    expect(await prodGetProviderHealth(LOOPBACK_URL)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
