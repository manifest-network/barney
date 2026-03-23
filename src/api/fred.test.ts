import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollLeaseUntilReady, connectLeaseEvents, waitForLeaseReady } from './fred';
import { LeaseState } from './billing';
import { ProviderApiError } from './provider-api';

// Mock the mono fred module to bypass checkedFetch's AbortController timeout,
// which conflicts with vi.useFakeTimers() in polling tests.
// The mock delegates getLeaseStatus to globalThis.fetch (stubbed per-test)
// with the same LeaseState conversion mono does internally.
vi.mock('@manifest-network/manifest-mcp-fred', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@manifest-network/manifest-mcp-fred')>();
  return {
    ...actual,
    getLeaseStatus: vi.fn(async (providerUrl: string, leaseUuid: string, authToken: string) => {
      const url = `${providerUrl.replace(/\/+$/, '')}/v1/leases/${encodeURIComponent(leaseUuid)}/status`;
      const res = await globalThis.fetch(url, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new actual.ProviderApiError(res.status, text);
      }
      const raw = await res.json();
      const { leaseStateFromString: convert } = await import('./billing');
      return { ...raw, state: convert(raw.state) };
    }),
  };
});

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

// HTTP function tests (getLeaseStatus, getLeaseLogs, etc.) are in mono's test suite.
// Tests below cover Barney-specific behavior: polling, WebSocket, and fallback logic.

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
    expect(fetchMock.mock.calls[0][1]?.headers).toHaveProperty('Authorization', 'Bearer dG9rZW4=');
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

  it('returns immediately via subscribe-then-fetch when lease is already ready', async () => {
    vi.stubGlobal('WebSocket', createMockWebSocket([]));

    const active = fredResponse('LEASE_STATE_ACTIVE', { provision_status: 'ready' });
    mockFetchSequence([{ data: active }]);

    const result = await waitForLeaseReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('ready');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls through to WS events when subscribe-then-fetch shows still provisioning', async () => {
    const readyEvent = { lease_uuid: LEASE_UUID, status: 'ready', timestamp: '2024-01-01T00:00:00Z' };
    vi.stubGlobal('WebSocket', createMockWebSocket([readyEvent]));

    const provisioning = fredResponse('LEASE_STATE_ACTIVE', { provision_status: 'provisioning' });
    mockFetchSequence([{ data: provisioning }]);

    const result = await waitForLeaseReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 100,
      maxAttempts: 5,
    });

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('ready');
  });

  it('continues via WS events when subscribe-then-fetch fails', async () => {
    const readyEvent = { lease_uuid: LEASE_UUID, status: 'ready', timestamp: '2024-01-01T00:00:00Z' };
    vi.stubGlobal('WebSocket', createMockWebSocket([readyEvent]));

    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network error')));

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
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
