import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
