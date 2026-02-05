import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLeaseStatus, pollLeaseUntilReady, getLeaseLogs, getLeaseProvision, getLeaseInfo } from './fred';
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
    const closed = fredResponse('LEASE_STATE_CLOSED', { error: 'container crashed' });
    mockFetchSequence([{ data: closed }]);

    const result = await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    expect(result.state).toBe(LeaseState.LEASE_STATE_CLOSED);
    expect(result.error).toBe('container crashed');
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
});

describe('getLeaseLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns logs keyed by instance', async () => {
    const logs = { '0': 'Starting server...', '1': 'Worker ready' };
    mockFetchResponse(logs);

    const result = await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result).toEqual(logs);
  });

  it('uses /logs/ path with tail parameter', async () => {
    mockFetchResponse({});

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, 50);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain(`/logs/${LEASE_UUID}?tail=50`);
    expect(fetchCall[0]).not.toContain('/v1/leases/');
  });

  it('defaults tail to 100', async () => {
    mockFetchResponse({});

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain('?tail=100');
  });

  it('passes auth header', async () => {
    mockFetchResponse({});

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

  it('uses /provisions/ path', async () => {
    mockFetchResponse({ status: 'running', fail_count: 0, last_error: '' });

    await getLeaseProvision(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain(`/provisions/${LEASE_UUID}`);
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

  it('uses /info/ path', async () => {
    mockFetchResponse({ host: 'https://app.example.com' });

    await getLeaseInfo(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain(`/info/${LEASE_UUID}`);
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
