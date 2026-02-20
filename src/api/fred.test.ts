import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLeaseStatus, pollLeaseUntilReady, getLeaseLogs, getLeaseProvision, getLeaseInfo, restartLease, updateLease, getLeaseReleases, connectLeaseEvents, waitForLeaseReady } from './fred';
import { LeaseState } from './billing';
import { ProviderApiError } from './provider-api';

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

const PROVIDER_URL = 'https://fred.example.com';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const AUTH_TOKEN = 'dG9rZW4=';

/** Mock fetch to return a raw fred response (state as chain-style string). */
function mockFetchResponse(data: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status,
      statusText: 'OK',
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    })
  );
}

/** Raw fred responses use chain-style state strings. */
function fredResponse(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { state, ...extra };
}

function mockFetchSequence(responses: Array<{ data: Record<string, unknown>; ok?: boolean; status?: number }>): void {
  const mockFn = vi.fn();
  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    mockFn.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'OK',
      json: () => Promise.resolve(r.data),
      text: () => Promise.resolve(JSON.stringify(r.data)),
    });
  }
  vi.stubGlobal('fetch', mockFn);
}

describe('getLeaseStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses LEASE_STATE_ACTIVE from fred', async () => {
    mockFetchResponse(fredResponse('LEASE_STATE_ACTIVE', { endpoints: { web: 'https://app.example.com' } }));

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.endpoints).toEqual({ web: 'https://app.example.com' });
  });

  it('parses LEASE_STATE_PENDING from fred', async () => {
    mockFetchResponse(fredResponse('LEASE_STATE_PENDING'));

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.state).toBe(LeaseState.LEASE_STATE_PENDING);
  });

  it('defaults to PENDING for unknown state strings', async () => {
    mockFetchResponse(fredResponse('SOMETHING_UNKNOWN'));

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.state).toBe(LeaseState.LEASE_STATE_PENDING);
  });

  it('passes auth header and correct URL', async () => {
    mockFetchResponse(fredResponse('LEASE_STATE_PENDING'));

    await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain(`/v1/leases/${LEASE_UUID}/status`);
    expect(fetchCall[1]?.headers).toHaveProperty('Authorization', `Bearer ${AUTH_TOKEN}`);
  });

  it('throws ProviderApiError on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('lease not found'),
      })
    );

    await expect(getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(
      ProviderApiError
    );
  });

  it('throws ProviderApiError on invalid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('invalid json')),
      })
    );

    await expect(getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(
      'invalid JSON'
    );
  });

  it('throws on invalid provider URL', async () => {
    // Override the mock to reject the URL
    const urlModule = await import('../utils/url');
    vi.spyOn(urlModule, 'parseHttpUrl').mockReturnValueOnce(null);

    await expect(getLeaseStatus('', LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(
      'Invalid provider API URL'
    );
  });

  it('parses stack services field from fred response', async () => {
    mockFetchResponse(fredResponse('LEASE_STATE_ACTIVE', {
      services: {
        web: { instances: [{ name: 'web-0', status: 'running', ports: { '80/tcp': 32456 } }] },
        db: { instances: [{ name: 'db-0', status: 'running' }] },
      },
    }));

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.services).toBeDefined();
    expect(Object.keys(result.services!)).toEqual(['web', 'db']);
    expect(result.services!.web.instances).toHaveLength(1);
    expect(result.services!.web.instances[0].name).toBe('web-0');
    expect(result.services!.db.instances).toHaveLength(1);
  });

  it('omits services when none present', async () => {
    mockFetchResponse(fredResponse('LEASE_STATE_ACTIVE'));

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.services).toBeUndefined();
  });

  it('filters invalid instances in services', async () => {
    mockFetchResponse(fredResponse('LEASE_STATE_ACTIVE', {
      services: {
        web: { instances: [{ name: 'web-0', status: 'running' }, 'invalid', null] },
      },
    }));

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.services!.web.instances).toHaveLength(1);
  });

  it('includes services with missing instances array (early provisioning)', async () => {
    mockFetchResponse(fredResponse('LEASE_STATE_ACTIVE', {
      services: {
        web: { instances: [{ name: 'web-0', status: 'running' }] },
        db: {},
      },
    }));

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.services).toBeDefined();
    expect(result.services!.web.instances).toHaveLength(1);
    expect(result.services!.db.instances).toHaveLength(0);
  });
});

describe('pollLeaseUntilReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns immediately when state is ACTIVE', async () => {
    const active = fredResponse('LEASE_STATE_ACTIVE', { endpoints: { web: 'https://app.example.com' } });
    mockFetchSequence([{ data: active }]);

    const result = await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns immediately when state is CLOSED', async () => {
    const closed = fredResponse('LEASE_STATE_CLOSED', { last_error: 'container crashed' });
    mockFetchSequence([{ data: closed }]);

    const result = await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    expect(result.state).toBe(LeaseState.LEASE_STATE_CLOSED);
    expect(result.last_error).toBe('container crashed');
  });

  it('polls until active after pending', async () => {
    const pending = fredResponse('LEASE_STATE_PENDING', { phase: 'pulling_image' });
    const active = fredResponse('LEASE_STATE_ACTIVE', { endpoints: { web: 'https://app.example.com' } });

    mockFetchSequence([
      { data: pending },
      { data: pending },
      { data: active },
    ]);

    const onProgress = vi.fn();

    const resultPromise = pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
      onProgress,
    });

    // Advance timers for the sleep intervals
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  it('returns last status on max attempts', async () => {
    const pending = fredResponse('LEASE_STATE_PENDING', { phase: 'pulling_image' });
    mockFetchSequence([
      { data: pending },
      { data: pending },
      { data: pending },
    ]);

    const resultPromise = pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 3,
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;
    expect(result.state).toBe(LeaseState.LEASE_STATE_PENDING);
  });

  it('continues polling on transient errors', async () => {
    const active = fredResponse('LEASE_STATE_ACTIVE');

    const mockFn = vi.fn();
    // First call: network error
    mockFn.mockRejectedValueOnce(new Error('network error'));
    // Second call: success
    mockFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(active),
      text: () => Promise.resolve(JSON.stringify(active)),
    });
    vi.stubGlobal('fetch', mockFn);

    const resultPromise = pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
  });

  it('calls getAuthToken before each status request when provided', async () => {
    const pending = fredResponse('LEASE_STATE_PENDING', { phase: 'pulling_image' });
    const active = fredResponse('LEASE_STATE_ACTIVE');

    mockFetchSequence([
      { data: pending },
      { data: active },
    ]);

    let callCount = 0;
    const getAuthToken = vi.fn(async () => {
      callCount++;
      return `fresh-token-${callCount}`;
    });

    const resultPromise = pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
      getAuthToken,
    });

    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(getAuthToken).toHaveBeenCalledTimes(2);

    // Verify each fetch used the token returned by getAuthToken
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls[0][1]?.headers).toHaveProperty('Authorization', 'Bearer fresh-token-1');
    expect(fetchMock.mock.calls[1][1]?.headers).toHaveProperty('Authorization', 'Bearer fresh-token-2');
  });

  it('uses static authToken when getAuthToken is not provided', async () => {
    const active = fredResponse('LEASE_STATE_ACTIVE');
    mockFetchSequence([{ data: active }]);

    const result = await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls[0][1]?.headers).toHaveProperty('Authorization', `Bearer ${AUTH_TOKEN}`);
  });

  it('respects abort signal', async () => {
    const pending = fredResponse('LEASE_STATE_PENDING');
    mockFetchSequence([{ data: pending }]);

    const controller = new AbortController();
    controller.abort();

    const result = await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 10,
      abortSignal: controller.signal,
    });

    // Should return initial status immediately since already aborted
    expect(result.state).toBe(LeaseState.LEASE_STATE_PENDING);
  });

  it('stops polling on ACTIVE + ready provision_status', async () => {
    const active = fredResponse('LEASE_STATE_ACTIVE', { provision_status: 'ready' });
    mockFetchSequence([{ data: active }]);

    const result = await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('ready');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('continues polling on ACTIVE + updating provision_status', async () => {
    const updating = fredResponse('LEASE_STATE_ACTIVE', { provision_status: 'updating' });
    const ready = fredResponse('LEASE_STATE_ACTIVE', { provision_status: 'ready' });

    mockFetchSequence([
      { data: updating },
      { data: updating },
      { data: ready },
    ]);

    const onProgress = vi.fn();

    const resultPromise = pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
      onProgress,
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('ready');
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('continues polling on ACTIVE + restarting provision_status', async () => {
    const restarting = fredResponse('LEASE_STATE_ACTIVE', { provision_status: 'restarting' });
    const ready = fredResponse('LEASE_STATE_ACTIVE', { provision_status: 'ready' });

    mockFetchSequence([
      { data: restarting },
      { data: ready },
    ]);

    const resultPromise = pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('ready');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops polling on ACTIVE without provision_status (backwards compat)', async () => {
    const active = fredResponse('LEASE_STATE_ACTIVE');
    mockFetchSequence([{ data: active }]);

    const result = await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops polling on ACTIVE + failed provision_status', async () => {
    const failed = fredResponse('LEASE_STATE_ACTIVE', { provision_status: 'failed' });
    mockFetchSequence([{ data: failed }]);

    const result = await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('getLeaseLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns logs response with nested logs', async () => {
    const response = {
      lease_uuid: LEASE_UUID,
      tenant: 'manifest1test',
      provider_uuid: 'provider-uuid',
      logs: { '0': 'Starting server...', '1': 'Worker ready' },
    };
    mockFetchResponse(response);

    const result = await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.logs).toEqual({ '0': 'Starting server...', '1': 'Worker ready' });
    expect(result.lease_uuid).toBe(LEASE_UUID);
  });

  it('uses /v1/leases/ path with tail parameter', async () => {
    mockFetchResponse({ lease_uuid: LEASE_UUID, tenant: '', provider_uuid: '', logs: {} });

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, 50);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain(`/v1/leases/${LEASE_UUID}/logs?tail=50`);
  });

  it('defaults tail to 100', async () => {
    mockFetchResponse({ lease_uuid: LEASE_UUID, tenant: '', provider_uuid: '', logs: {} });

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain('?tail=100');
  });

  it('passes auth header', async () => {
    mockFetchResponse({ lease_uuid: LEASE_UUID, tenant: '', provider_uuid: '', logs: {} });

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[1]?.headers).toHaveProperty('Authorization', `Bearer ${AUTH_TOKEN}`);
  });

  it('throws ProviderApiError on HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('server error'),
      })
    );

    await expect(getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(
      ProviderApiError
    );
  });

  it('throws ProviderApiError on invalid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('invalid json')),
      })
    );

    await expect(getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(
      'invalid JSON'
    );
  });
});

describe('getLeaseProvision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns provision with last_error', async () => {
    const provision = { status: 'failed', fail_count: 3, last_error: 'OOMKilled' };
    mockFetchResponse(provision);

    const result = await getLeaseProvision(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.last_error).toBe('OOMKilled');
    expect(result.fail_count).toBe(3);
    expect(result.status).toBe('failed');
  });

  it('uses /v1/leases/ path', async () => {
    mockFetchResponse({ status: 'running', fail_count: 0, last_error: '' });

    await getLeaseProvision(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain(`/v1/leases/${LEASE_UUID}/provision`);
  });

  it('throws ProviderApiError on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('not found'),
      })
    );

    await expect(getLeaseProvision(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(
      ProviderApiError
    );
  });

  it('throws ProviderApiError on HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: () => Promise.resolve('bad gateway'),
      })
    );

    await expect(getLeaseProvision(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(
      ProviderApiError
    );
  });
});

describe('getLeaseInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns connection details', async () => {
    const info = { host: 'https://app.example.com', ports: { http: 80, https: 443 } };
    mockFetchResponse(info);

    const result = await getLeaseInfo(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.host).toBe('https://app.example.com');
    expect(result.ports).toEqual({ http: 80, https: 443 });
  });

  it('uses /v1/leases/ info path', async () => {
    mockFetchResponse({ host: 'https://app.example.com' });

    await getLeaseInfo(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain(`/v1/leases/${LEASE_UUID}/info`);
  });

  it('throws ProviderApiError on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('not ready'),
      })
    );

    await expect(getLeaseInfo(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(
      ProviderApiError
    );
  });

  it('passes auth header', async () => {
    mockFetchResponse({ host: 'https://app.example.com' });

    await getLeaseInfo(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[1]?.headers).toHaveProperty('Authorization', `Bearer ${AUTH_TOKEN}`);
  });
});

describe('restartLease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends POST to restart endpoint', async () => {
    mockFetchResponse({ status: 'restarting' });

    const result = await restartLease(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.status).toBe('restarting');

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain(`/v1/leases/${LEASE_UUID}/restart`);
    expect(fetchCall[1]?.method).toBe('POST');
    expect(fetchCall[1]?.headers).toHaveProperty('Authorization', `Bearer ${AUTH_TOKEN}`);
  });

  it('throws ProviderApiError on 409 (wrong state)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        text: () => Promise.resolve('lease is not running'),
      })
    );

    await expect(restartLease(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(
      ProviderApiError
    );
  });

  it('throws ProviderApiError on HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('server error'),
      })
    );

    await expect(restartLease(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(
      ProviderApiError
    );
  });

  it('throws ProviderApiError on invalid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('invalid json')),
      })
    );

    await expect(restartLease(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(
      'invalid JSON'
    );
  });
});

describe('updateLease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends POST with payload to update endpoint', async () => {
    mockFetchResponse({ status: 'updating' });

    const payload = btoa('{"image":"nginx:latest"}');
    const result = await updateLease(PROVIDER_URL, LEASE_UUID, payload, AUTH_TOKEN);
    expect(result.status).toBe('updating');

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain(`/v1/leases/${LEASE_UUID}/update`);
    expect(fetchCall[1]?.method).toBe('POST');
    expect(fetchCall[1]?.headers).toHaveProperty('Authorization', `Bearer ${AUTH_TOKEN}`);

    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.payload).toBe(payload);
  });

  it('throws ProviderApiError on 409', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        text: () => Promise.resolve('lease is not running'),
      })
    );

    await expect(updateLease(PROVIDER_URL, LEASE_UUID, 'payload', AUTH_TOKEN)).rejects.toThrow(
      ProviderApiError
    );
  });

  it('throws ProviderApiError on HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('server error'),
      })
    );

    await expect(updateLease(PROVIDER_URL, LEASE_UUID, 'payload', AUTH_TOKEN)).rejects.toThrow(
      ProviderApiError
    );
  });

  it('throws ProviderApiError on invalid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('invalid json')),
      })
    );

    await expect(updateLease(PROVIDER_URL, LEASE_UUID, 'payload', AUTH_TOKEN)).rejects.toThrow(
      'invalid JSON'
    );
  });
});

describe('getLeaseReleases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns releases response', async () => {
    const response = {
      lease_uuid: LEASE_UUID,
      tenant: 'manifest1test',
      provider_uuid: 'provider-uuid',
      releases: [
        { version: 1, image: 'nginx:1.0', status: 'active', created_at: '2024-01-01T00:00:00Z' },
        { version: 2, image: 'nginx:2.0', status: 'superseded', created_at: '2024-01-02T00:00:00Z', error: 'OOM' },
      ],
    };
    mockFetchResponse(response);

    const result = await getLeaseReleases(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.releases).toHaveLength(2);
    expect(result.releases[0].version).toBe(1);
    expect(result.releases[1].error).toBe('OOM');
    expect(result.lease_uuid).toBe(LEASE_UUID);
  });

  it('uses /v1/leases/ path', async () => {
    mockFetchResponse({ lease_uuid: LEASE_UUID, tenant: '', provider_uuid: '', releases: [] });

    await getLeaseReleases(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain(`/v1/leases/${LEASE_UUID}/releases`);
  });

  it('passes auth header', async () => {
    mockFetchResponse({ lease_uuid: LEASE_UUID, tenant: '', provider_uuid: '', releases: [] });

    await getLeaseReleases(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[1]?.headers).toHaveProperty('Authorization', `Bearer ${AUTH_TOKEN}`);
  });

  it('throws ProviderApiError on HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('not found'),
      })
    );

    await expect(getLeaseReleases(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(
      ProviderApiError
    );
  });

  it('throws ProviderApiError on invalid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('invalid json')),
      })
    );

    await expect(getLeaseReleases(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(
      'invalid JSON'
    );
  });
});

// ============================================================================
// WebSocket tests
// ============================================================================

/** Helper: create a mock WebSocket that emits events from an array. */
function createMockWebSocket(events: unknown[], shouldFail = false) {
  return class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;

    constructor() {
      // Simulate async open/error
      setTimeout(() => {
        if (shouldFail) {
          this.readyState = 0;
          this.onerror?.();
          this.onclose?.({ code: 1006, reason: 'connection failed' });
          return;
        }
        this.onopen?.({});
        // Send events
        for (const event of events) {
          this.onmessage?.({ data: JSON.stringify(event) });
        }
        // Close after sending events
        this.readyState = 3;
        this.onclose?.({ code: 1000, reason: '' });
      }, 0);
    }

    close() {
      this.readyState = 3;
    }
  };
}

describe('connectLeaseEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects when WebSocket connection fails', async () => {
    vi.stubGlobal('WebSocket', createMockWebSocket([], true));

    await expect(connectLeaseEvents(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(
      ProviderApiError
    );
  });

  it('yields events from WebSocket messages', async () => {
    const event = { lease_uuid: LEASE_UUID, status: 'ready', timestamp: '2024-01-01T00:00:00Z' };
    vi.stubGlobal('WebSocket', createMockWebSocket([event]));

    const conn = await connectLeaseEvents(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(conn).toHaveProperty('events');
    expect(conn).toHaveProperty('close');

    const events: unknown[] = [];
    for await (const e of conn.events) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it('yields multiple events', async () => {
    const event1 = { lease_uuid: LEASE_UUID, status: 'provisioning', timestamp: '2024-01-01T00:00:00Z' };
    const event2 = { lease_uuid: LEASE_UUID, status: 'ready', timestamp: '2024-01-01T00:00:01Z' };
    vi.stubGlobal('WebSocket', createMockWebSocket([event1, event2]));

    const conn = await connectLeaseEvents(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    const events: unknown[] = [];
    for await (const e of conn.events) {
      events.push(e);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(event1);
    expect(events[1]).toEqual(event2);
  });
});

describe('waitForLeaseReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns immediately when WS delivers a ready event', async () => {
    const readyEvent = { lease_uuid: LEASE_UUID, status: 'ready', timestamp: '2024-01-01T00:00:00Z' };
    vi.stubGlobal('WebSocket', createMockWebSocket([readyEvent]));

    const result = await waitForLeaseReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('ready');
  });

  it('falls back to polling when WS connection fails', async () => {
    vi.stubGlobal('WebSocket', createMockWebSocket([], true));

    const active = fredResponse('LEASE_STATE_ACTIVE', { provision_status: 'ready' });
    mockFetchSequence([{ data: active }]);

    const result = await waitForLeaseReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('ready');
  });

  it('skips WS when disableWS is true', async () => {
    const active = fredResponse('LEASE_STATE_ACTIVE', { provision_status: 'ready' });
    mockFetchSequence([{ data: active }]);

    const result = await waitForLeaseReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
      disableWS: true,
    });

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('ready');
    // Only 1 fetch call (polling), no WS attempt
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
