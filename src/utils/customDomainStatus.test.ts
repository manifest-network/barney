import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computeStatus,
  resolveDnsViaDoh,
  probeHttps,
} from './customDomainStatus';

describe('computeStatus', () => {
  it('returns pending_dns when DNS does not resolve', () => {
    expect(computeStatus({ dns: { result: 'nxdomain' }, https: { result: 'unreachable' } })).toEqual({ kind: 'pending_dns' });
    expect(computeStatus({ dns: { result: 'network_fail' }, https: { result: 'unreachable' } })).toEqual({ kind: 'pending_dns' });
  });

  it('returns issuing_cert when DNS ok but HTTPS unreachable', () => {
    expect(computeStatus({ dns: { result: 'ok', cname: 'foo.bar' }, https: { result: 'unreachable' } })).toEqual({ kind: 'issuing_cert' });
  });

  it('returns active when both DNS and HTTPS ok', () => {
    expect(computeStatus({ dns: { result: 'ok', cname: 'foo.bar' }, https: { result: 'ok' } })).toEqual({ kind: 'active' });
  });

  it('returns pending_dns with mismatch detail when DNS points at wrong CNAME target', () => {
    expect(
      computeStatus({
        dns: { result: 'ok', cname: 'wrong.host' },
        https: { result: 'ok' },
        expectedCname: 'expected.host',
      }),
    ).toEqual({
      kind: 'pending_dns',
      detail: 'Pointed at wrong.host — expected expected.host',
    });
  });

  it('uses the normalized actual/expected (case-insensitive, trailing-dot stripped) in the detail', () => {
    const r = computeStatus({
      dns: { result: 'ok', cname: 'Wrong.Host.' },
      https: { result: 'ok' },
      expectedCname: 'Expected.Host',
    });
    expect(r.kind).toBe('pending_dns');
    expect(r.detail).toBe('Pointed at wrong.host — expected expected.host');
  });

  it('treats matching cname (case-insensitive, trailing-dot tolerant) as active', () => {
    expect(
      computeStatus({
        dns: { result: 'ok', cname: 'Expected.Host.' },
        https: { result: 'ok' },
        expectedCname: 'expected.host',
      }),
    ).toEqual({ kind: 'active' });
  });

  it('does not require cname when expectedCname is unset (A record alone is fine)', () => {
    expect(
      computeStatus({
        dns: { result: 'ok', addresses: ['1.2.3.4'] },
        https: { result: 'ok' },
      }),
    ).toEqual({ kind: 'active' });
  });

  it('leaves detail unset when there is no mismatch to report', () => {
    const r = computeStatus({ dns: { result: 'ok' }, https: { result: 'ok' } });
    expect(r.detail).toBeUndefined();
  });
});

describe('resolveDnsViaDoh', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch') as any;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns ok with addresses on A record hit', async () => {
    fetchSpy.mockImplementation((url: string) => {
      const type = url.match(/type=(\w+)/)?.[1];
      const body = type === 'A'
        ? { Status: 0, Answer: [{ name: 'app.example.com', type: 1, data: '1.2.3.4' }] }
        : { Status: 0 };
      return Promise.resolve(new Response(JSON.stringify(body)) as any);
    });
    const r = await resolveDnsViaDoh('app.example.com');
    expect(r.result).toBe('ok');
    expect(r.addresses).toEqual(['1.2.3.4']);
  });

  it('returns ok with cname on CNAME record hit', async () => {
    fetchSpy.mockImplementation((url: string) => {
      const isCname = url.includes('type=CNAME');
      const body = isCname
        ? { Status: 0, Answer: [{ name: 'app.example.com', type: 5, data: 'target.example.net.' }] }
        : { Status: 0 };
      return Promise.resolve(new Response(JSON.stringify(body)) as any);
    });
    const r = await resolveDnsViaDoh('app.example.com');
    expect(r.result).toBe('ok');
    expect(r.cname).toBe('target.example.net');
  });

  it('returns nxdomain when DoH responds with no records', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ Status: 3 })) as any),
    );
    const r = await resolveDnsViaDoh('nonexistent.example.com');
    expect(r.result).toBe('nxdomain');
  });

  it('returns network_fail on fetch error', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    const r = await resolveDnsViaDoh('blocked.example.com');
    expect(r.result).toBe('network_fail');
  });

  it('returns nxdomain on Status 0 (NoError) with no answers (NODATA case)', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ Status: 0 })) as any),
    );
    const r = await resolveDnsViaDoh('nodata.example.com');
    expect(r.result).toBe('nxdomain');
  });

  it('returns network_fail on SERVFAIL (Status 2)', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ Status: 2 })) as any),
    );
    const r = await resolveDnsViaDoh('servfail.example.com');
    expect(r.result).toBe('network_fail');
  });

  it('returns network_fail on REFUSED (Status 5)', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ Status: 5 })) as any),
    );
    const r = await resolveDnsViaDoh('refused.example.com');
    expect(r.result).toBe('network_fail');
  });

  it('still returns ok when one query succeeds and another SERVFAILs', async () => {
    fetchSpy.mockImplementation((url: string) => {
      const type = url.match(/type=(\w+)/)?.[1];
      const body = type === 'A'
        ? { Status: 0, Answer: [{ name: 'mixed.example.com', type: 1, data: '1.2.3.4' }] }
        : { Status: 2 }; // SERVFAIL on AAAA + CNAME
      return Promise.resolve(new Response(JSON.stringify(body)) as any);
    });
    const r = await resolveDnsViaDoh('mixed.example.com');
    expect(r.result).toBe('ok');
    expect(r.addresses).toEqual(['1.2.3.4']);
  });

  it('returns ok with AAAA address on IPv6-only domain', async () => {
    fetchSpy.mockImplementation((url: string) => {
      const isAaaa = url.includes('type=AAAA');
      const body = isAaaa
        ? { Status: 0, Answer: [{ name: 'v6.example.com', type: 28, data: '2606:4700::1111' }] }
        : { Status: 0 };
      return Promise.resolve(new Response(JSON.stringify(body)) as any);
    });
    const r = await resolveDnsViaDoh('v6.example.com');
    expect(r.result).toBe('ok');
    expect(r.addresses).toEqual(['2606:4700::1111']);
  });

  it('queries A, AAAA, and CNAME in parallel', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ Status: 3 })) as any),
    );
    await resolveDnsViaDoh('app.example.com');
    const types = fetchSpy.mock.calls.map((c: unknown[]) => {
      const u = String(c[0]);
      return u.match(/type=(\w+)/)?.[1];
    });
    expect(types).toContain('A');
    expect(types).toContain('AAAA');
    expect(types).toContain('CNAME');
  });

  it('aborts immediately when external signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    fetchSpy.mockImplementation((_url: string, opts?: RequestInit) => {
      // The propagated signal must already be aborted before fetch is called.
      if (opts?.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
      return Promise.resolve(new Response(JSON.stringify({ Status: 0 })) as any);
    });
    const r = await resolveDnsViaDoh('app.example.com', ac.signal);
    expect(r.result).toBe('network_fail');
  });
});

describe('probeHttps', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch') as any;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns ok on opaque success', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 0 }) as any);
    expect((await probeHttps('app.example.com')).result).toBe('ok');
  });

  it('returns ok even on 5xx (HTTPS handshake succeeded)', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 503 }) as any);
    expect((await probeHttps('app.example.com')).result).toBe('ok');
  });

  it('returns unreachable on fetch rejection', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    expect((await probeHttps('blocked.example.com')).result).toBe('unreachable');
  });

  it('passes mode:no-cors to fetch', async () => {
    fetchSpy.mockResolvedValue(new Response(null) as any);
    await probeHttps('app.example.com');
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(opts.mode).toBe('no-cors');
  });

  it('aborts immediately when external signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    fetchSpy.mockImplementation((_url: string, opts?: RequestInit) => {
      if (opts?.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
      return Promise.resolve(new Response(null) as any);
    });
    const r = await probeHttps('app.example.com', ac.signal);
    expect(r.result).toBe('unreachable');
  });
});
