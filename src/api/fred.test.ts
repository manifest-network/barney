import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLeaseStatus, pollLeaseUntilReady, type FredLeaseStatus } from './fred';
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

function mockFetchSequence(responses: Array<{ data: FredLeaseStatus; ok?: boolean; status?: number }>): void {
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

  it('returns lease status on success', async () => {
    const status: FredLeaseStatus = {
      status: 'ready',
      endpoints: { web: 'https://app.example.com' },
    };
    mockFetchResponse(status);

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result).toEqual(status);
  });

  it('passes auth header and correct URL', async () => {
    mockFetchResponse({ status: 'provisioning' });

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

  it('returns immediately when status is ready', async () => {
    const readyStatus: FredLeaseStatus = { status: 'ready', endpoints: { web: 'https://app.example.com' } };
    mockFetchSequence([{ data: readyStatus }]);

    const result = await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    expect(result.status).toBe('ready');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns immediately when status is failed', async () => {
    const failedStatus: FredLeaseStatus = { status: 'failed', error: 'container crashed' };
    mockFetchSequence([{ data: failedStatus }]);

    const result = await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('container crashed');
  });

  it('polls until ready after provisioning', async () => {
    const provisioning: FredLeaseStatus = { status: 'provisioning', phase: 'pulling_image' };
    const ready: FredLeaseStatus = { status: 'ready', endpoints: { web: 'https://app.example.com' } };

    mockFetchSequence([
      { data: provisioning },
      { data: provisioning },
      { data: ready },
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

    expect(result.status).toBe('ready');
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenCalledWith(provisioning);
    expect(onProgress).toHaveBeenCalledWith(ready);
  });

  it('returns last status on max attempts', async () => {
    const provisioning: FredLeaseStatus = { status: 'provisioning', phase: 'pulling_image' };
    mockFetchSequence([
      { data: provisioning },
      { data: provisioning },
      { data: provisioning },
    ]);

    const resultPromise = pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 3,
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;
    expect(result.status).toBe('provisioning');
  });

  it('continues polling on transient errors', async () => {
    const ready: FredLeaseStatus = { status: 'ready' };

    const mockFn = vi.fn();
    // First call: network error
    mockFn.mockRejectedValueOnce(new Error('network error'));
    // Second call: success
    mockFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(ready),
      text: () => Promise.resolve(JSON.stringify(ready)),
    });
    vi.stubGlobal('fetch', mockFn);

    const resultPromise = pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;
    expect(result.status).toBe('ready');
  });

  it('respects abort signal', async () => {
    const provisioning: FredLeaseStatus = { status: 'provisioning' };
    mockFetchSequence([{ data: provisioning }]);

    const controller = new AbortController();
    controller.abort();

    const result = await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 10,
      abortSignal: controller.signal,
    });

    // Should return initial status immediately since already aborted
    expect(result.status).toBe('provisioning');
  });
});
