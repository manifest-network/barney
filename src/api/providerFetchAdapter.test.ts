import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ProviderApiError,
  isTransientProviderError,
  getProviderHealth as sdkGetProviderHealth,
} from '@manifest-network/manifest-sdk/deploy';
import { createProviderFetch } from './providerFetchAdapter';

// These exercise the PROD branch by stubbing import.meta.env.DEV = false.
// createProviderFetch reads import.meta.env.DEV inside the returned closure at
// call time, so stubbing before invocation is sufficient. Real parseHttpUrl /
// isUrlSsrfSafe from ../utils/url are used (no mock) — a link-local metadata IP
// is genuinely SSRF-unsafe and a public host is genuinely safe.
describe('createProviderFetch — PROD redirect hardening', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('DEV', false); // force PROD branch
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('passes a 200 through, sending redirect:"manual" and a sanitized URL', async () => {
    fetchSpy.mockResolvedValue({ type: 'basic', status: 200 } as Response);
    const providerFetch = createProviderFetch();

    const res = await providerFetch('https://user:pass@fred.example.com/v1/leases?x=1');

    expect((res as unknown as { status: number }).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    // Credentials stripped, reconstructed from origin + pathname + search.
    expect(calledUrl).toBe('https://fred.example.com/v1/leases?x=1');
    expect(calledInit.redirect).toBe('manual');
  });

  it('throws on an opaqueredirect response', async () => {
    fetchSpy.mockResolvedValue({ type: 'opaqueredirect', status: 0 } as Response);
    const providerFetch = createProviderFetch();

    await expect(providerFetch('https://fred.example.com/v1/x')).rejects.toThrow(
      'unexpected redirect'
    );
  });

  it('throws on a 3xx status response', async () => {
    fetchSpy.mockResolvedValue({ type: 'basic', status: 302 } as Response);
    const providerFetch = createProviderFetch();

    await expect(providerFetch('https://fred.example.com/v1/x')).rejects.toThrow(
      'unexpected redirect'
    );
  });

  it('throws the SSRF error for an unsafe initial URL and never calls fetch', async () => {
    const providerFetch = createProviderFetch();

    await expect(
      providerFetch('http://169.254.169.254/latest/meta-data')
    ).rejects.toThrow('blocked by SSRF validation');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not let a caller-supplied redirect:"follow" override the forced redirect:"manual"', async () => {
    fetchSpy.mockResolvedValue({ type: 'basic', status: 200 } as Response);
    const providerFetch = createProviderFetch();

    await providerFetch('https://fred.example.com/v1/x', { redirect: 'follow' });

    const [, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledInit.redirect).toBe('manual');
  });
});

// The DEV branch routes through the same-origin /proxy-provider CORS proxy and
// carries the real upstream in X-Proxy-Target. It got the same redirect
// hardening as PROD (forced redirect:"manual" + reject 3xx/opaque), so lock in
// that behavior here.
describe('createProviderFetch — DEV proxy + redirect hardening', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('DEV', true); // force DEV branch
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('routes through /proxy-provider with X-Proxy-Target and redirect:"manual"', async () => {
    fetchSpy.mockResolvedValue({ type: 'basic', status: 200 } as Response);
    const providerFetch = createProviderFetch();

    const res = await providerFetch('https://fred.example.com/v1/leases?x=1');

    expect((res as unknown as { status: number }).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('/proxy-provider/v1/leases?x=1');
    expect((calledInit.headers as Headers).get('X-Proxy-Target')).toBe('https://fred.example.com');
    expect(calledInit.redirect).toBe('manual');
  });

  it('throws on an opaqueredirect response', async () => {
    fetchSpy.mockResolvedValue({ type: 'opaqueredirect', status: 0 } as Response);
    const providerFetch = createProviderFetch();

    await expect(providerFetch('https://fred.example.com/v1/x')).rejects.toThrow(
      'unexpected redirect'
    );
  });

  it('throws on a 3xx status response', async () => {
    fetchSpy.mockResolvedValue({ type: 'basic', status: 301 } as Response);
    const providerFetch = createProviderFetch();

    await expect(providerFetch('https://fred.example.com/v1/x')).rejects.toThrow(
      'unexpected redirect'
    );
  });

  it('does not let a caller-supplied redirect:"follow" override the forced redirect:"manual"', async () => {
    fetchSpy.mockResolvedValue({ type: 'basic', status: 200 } as Response);
    const providerFetch = createProviderFetch();

    await providerFetch('https://fred.example.com/v1/x', { redirect: 'follow' });

    const [, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledInit.redirect).toBe('manual');
  });
});

// Barney's own guard rejections are hard security blocks, not blips. They are
// thrown as `ProviderApiError` tagged `invalid_url` — the kind the SDK's
// `isTransientProviderError` classifies as NOT worth retrying — so a caller that
// unwraps them cannot mistake a block for a network hiccup.
describe('createProviderFetch — guard rejections are non-transient ProviderApiErrors', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const expectBlocked = (err: unknown) => {
    expect(ProviderApiError.isProviderApiError(err)).toBe(true);
    const e = err as ProviderApiError;
    expect(e.kind).toBe('invalid_url');
    expect(e.status).toBe(0);
    expect(isTransientProviderError(e)).toBe(false);
  };

  it('tags the PROD SSRF rejection invalid_url', async () => {
    vi.stubEnv('DEV', false);
    const providerFetch = createProviderFetch();

    await providerFetch('http://169.254.169.254/latest/meta-data').then(
      () => expect.unreachable('should have been blocked'),
      expectBlocked
    );
  });

  it('tags the PROD redirect rejection invalid_url', async () => {
    vi.stubEnv('DEV', false);
    fetchSpy.mockResolvedValue({ type: 'basic', status: 302 } as Response);
    const providerFetch = createProviderFetch();

    await providerFetch('https://fred.example.com/v1/x').then(
      () => expect.unreachable('should have been blocked'),
      expectBlocked
    );
  });

  it('tags the DEV redirect rejection invalid_url', async () => {
    vi.stubEnv('DEV', true);
    fetchSpy.mockResolvedValue({ type: 'opaqueredirect', status: 0 } as Response);
    const providerFetch = createProviderFetch();

    await providerFetch('https://fred.example.com/v1/x').then(
      () => expect.unreachable('should have been blocked'),
      expectBlocked
    );
  });
});

// DRIFT DETECTOR, not a desired behaviour. manifest-mcp-fred 0.21.0's
// `classifyTransportError` re-wraps EVERY rejection from an injected `fetchFn`
// as `kind: 'network'` without checking whether it is already classified, so the
// `invalid_url` tag above survives only on `.cause` and the error a caller sees
// is still "transient". If this test starts failing, the SDK has learned to
// honour a pre-classified error — drop the KNOWN LIMITATION note in
// providerFetchAdapter.ts and this block with it.
describe('SDK re-wrap of a Barney guard rejection (upstream limitation)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reaches the caller as kind:"network" with the block preserved on .cause', async () => {
    vi.stubEnv('DEV', false);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ type: 'basic', status: 302 } as Response)
    );

    const err = await sdkGetProviderHealth(
      'https://fred.example.com',
      5000,
      createProviderFetch(),
      false
    ).then(
      () => expect.unreachable('should have been blocked'),
      (e: unknown) => e as ProviderApiError
    );

    expect(err.kind).toBe('network');
    expect(isTransientProviderError(err)).toBe(true);
    // Barney's classification is not lost — it is one level down.
    expect((err.cause as ProviderApiError | undefined)?.kind).toBe('invalid_url');
    expect((err.cause as Error | undefined)?.message).toContain('unexpected redirect');
  });
});
