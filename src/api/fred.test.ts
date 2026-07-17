import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getLeaseLogs } from './fred';
import { getLeaseLogs as sdkGetLeaseLogs } from '@manifest-network/manifest-sdk/deploy';
import { providerFetch } from './providerFetchAdapter';

// Mock the SDK ./deploy facade (source of the fred HTTP fns) so the wrapper test
// can assert arg forwarding without a real HTTP call. ENG-312 Phase 6 removed
// the hand-rolled polling + WebSocket machinery (now the SDK's waitForLeaseStatus
// + browserEventTransport), so only the thin HTTP wrappers remain to test here.
vi.mock('@manifest-network/manifest-sdk/deploy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@manifest-network/manifest-sdk/deploy')>()),
  getLeaseLogs: vi.fn(),
}));

// providerFetch is the DEV-proxy / PROD-SSRF fetch adapter the wrapper injects as fetchFn.
vi.mock('./providerFetchAdapter', () => ({
  providerFetch: vi.fn(),
}));

const PROVIDER_URL = 'https://fred.example.com';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const AUTH_TOKEN = 'dG9rZW4=';

describe('getLeaseLogs wrapper', () => {
  beforeEach(() => vi.clearAllMocks());

  const LOGS = {
    lease_uuid: LEASE_UUID,
    tenant: 'manifest1abc',
    provider_uuid: 'p1',
    logs: { web: 'log output' },
  };

  it('forwards to the SDK deploy getLeaseLogs with providerFetch as fetchFn and default tail 100', async () => {
    vi.mocked(sdkGetLeaseLogs).mockResolvedValue(LOGS);

    const result = await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);

    expect(result).toBe(LOGS);
    expect(sdkGetLeaseLogs).toHaveBeenCalledWith(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      100,
      providerFetch,
      import.meta.env.DEV, // allowLoopback (ENG-490)
    );
  });

  it('forwards an explicit tail unchanged', async () => {
    vi.mocked(sdkGetLeaseLogs).mockResolvedValue(LOGS);

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, 500);

    expect(sdkGetLeaseLogs).toHaveBeenCalledWith(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      500,
      providerFetch,
      import.meta.env.DEV, // allowLoopback (ENG-490)
    );
  });
});
