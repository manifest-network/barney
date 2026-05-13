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
    // Fixture updated: provide expectedCname so the new known-target gate
    // doesn't short-circuit to pending. Test intent (DNS resolves to the
    // right target but HTTPS handshake hasn't completed → issuing) is
    // unchanged.
    expect(computeStatus({
      dns: { result: 'ok', cname: 'foo.bar' },
      https: { result: 'unreachable' },
      expectedCname: 'foo.bar',
    })).toEqual({ kind: 'issuing_cert' });
  });

  it('returns active when both DNS and HTTPS ok', () => {
    // Fixture updated: provide expectedCname matching the resolved cname so
    // the new known-target gate doesn't short-circuit to pending.
    expect(computeStatus({
      dns: { result: 'ok', cname: 'foo.bar' },
      https: { result: 'ok' },
      expectedCname: 'foo.bar',
    })).toEqual({ kind: 'active' });
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

  // Regression: a user points an A record (no CNAME) at an unrelated HTTPS
  // host. Without the apex-aware mismatch check, the no-cors HTTPS probe
  // lets ANY responsive endpoint flash `active` and the sidebar dot would
  // go green for the wrong app. See PR #93 Copilot 3236837816.
  it('flags A-only DNS as pending_dns for non-apex with expected CNAME', () => {
    const r = computeStatus({
      dns: { result: 'ok', addresses: ['1.2.3.4'] },
      https: { result: 'ok' },
      expectedCname: 'auto.barney0.manifest0.net',
      isApex: false,
    });
    expect(r.kind).toBe('pending_dns');
    expect(r.detail).toMatch(/CNAME/);
    expect(r.detail).toMatch(/auto\.barney0\.manifest0\.net/);
  });

  // Apex domains can't use CNAME per RFC 1912 — legitimate apex configs
  // resolve via A/AAAA from ALIAS / ANAME / CNAME-flattening. Skip the new
  // missing-CNAME check for apex; the HTTPS probe still decides active vs
  // issuing.
  it('allows A-only DNS for apex domains with expected CNAME (ALIAS / ANAME legal)', () => {
    const r = computeStatus({
      dns: { result: 'ok', addresses: ['1.2.3.4'] },
      https: { result: 'ok' },
      expectedCname: 'auto.barney0.manifest0.net',
      isApex: true,
    });
    expect(r.kind).toBe('active');
  });

  // Regression baseline: the existing wrong-CNAME mismatch path is
  // unchanged regardless of apex status — wrong target is wrong target.
  it('still detects CNAME mismatch for non-apex when CNAME present', () => {
    const r = computeStatus({
      dns: { result: 'ok', cname: 'wrong.host' },
      https: { result: 'ok' },
      expectedCname: 'expected.host',
      isApex: false,
    });
    expect(r.kind).toBe('pending_dns');
    expect(r.detail).toBe('Pointed at wrong.host — expected expected.host');
  });

  // Regression: without an expected CNAME target the reducer can't validate
  // the user's DNS config, and the no-cors HTTPS probe succeeds for any
  // responsive host. Reaching `active` here would terminal-lock a
  // false-positive (useDnsStatusPolling.ts:108 filters terminal entries out
  // of subsequent polls — even after the target appears in the registry).
  // See PR #93 Copilot 3237018335.
  it('returns pending_dns when expectedCname is undefined (target not yet known)', () => {
    const r = computeStatus({
      dns: { result: 'ok', addresses: ['1.2.3.4'] },
      https: { result: 'ok' },
    });
    expect(r.kind).toBe('pending_dns');
    expect(r.detail).toMatch(/Waiting for provider/);
  });

  // Apex domains skip the A-only gate (RFC 1912 / RFC 1034 §3.6.2 — apex
  // CNAMEs are forbidden, so apex configs legitimately resolve via A/AAAA).
  // But without an expected target, there's no oracle to validate against
  // — same terminal-lock hazard as non-apex. Both arms gate on target
  // availability before reaching active.
  it('apex domain with undefined target still pending_dns (no oracle to check against)', () => {
    const r = computeStatus({
      dns: { result: 'ok', addresses: ['1.2.3.4'] },
      https: { result: 'ok' },
      isApex: true,
    });
    expect(r.kind).toBe('pending_dns');
    expect(r.detail).toMatch(/Waiting for provider/);
  });

  it('leaves detail unset when there is no mismatch to report', () => {
    // Fixture updated post-`5656d94`: undefined `expectedCname` now sets a
    // "Waiting for provider…" detail by design. The "no detail when nothing
    // to report" assertion stays valid in the known-target-matching-CNAME
    // path, which is what this test now exercises.
    const r = computeStatus({
      dns: { result: 'ok', cname: 'expected.host' },
      https: { result: 'ok' },
      expectedCname: 'expected.host',
    });
    expect(r.kind).toBe('active');
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

  describe('multi-provider rotation', () => {
    it('queries both Cloudflare and Google in parallel', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ Status: 3 })) as any),
      );
      await resolveDnsViaDoh('app.example.com');
      const hosts = fetchSpy.mock.calls.map((c: unknown[]) => new URL(String(c[0])).host);
      expect(hosts).toContain('cloudflare-dns.com');
      expect(hosts).toContain('dns.google');
      // Each provider gets its own A + AAAA + CNAME burst → 6 calls total.
      expect(fetchSpy.mock.calls.length).toBe(6);
    });

    it('takes a positive answer from one provider when the other returns NXDOMAIN (defeats negative caching)', async () => {
      fetchSpy.mockImplementation((url: string) => {
        const u = new URL(url);
        const isCloudflare = u.host === 'cloudflare-dns.com';
        // Cloudflare has stale NXDOMAIN cached. Google sees the just-published record.
        if (isCloudflare) return Promise.resolve(new Response(JSON.stringify({ Status: 3 })) as any);
        const type = u.searchParams.get('type');
        const body = type === 'CNAME'
          ? { Status: 0, Answer: [{ name: 'app.example.com', type: 5, data: 'target.example.net.' }] }
          : { Status: 0 };
        return Promise.resolve(new Response(JSON.stringify(body)) as any);
      });
      const r = await resolveDnsViaDoh('app.example.com');
      expect(r.result).toBe('ok');
      expect(r.cname).toBe('target.example.net');
    });

    it('prefers the provider answer carrying a CNAME when multiple are positive', async () => {
      fetchSpy.mockImplementation((url: string) => {
        const u = new URL(url);
        const isCloudflare = u.host === 'cloudflare-dns.com';
        const type = u.searchParams.get('type');
        // Cloudflare: A only. Google: A + CNAME.
        if (isCloudflare) {
          const body = type === 'A'
            ? { Status: 0, Answer: [{ name: 'app.example.com', type: 1, data: '1.2.3.4' }] }
            : { Status: 0 };
          return Promise.resolve(new Response(JSON.stringify(body)) as any);
        }
        const body = type === 'CNAME'
          ? { Status: 0, Answer: [{ name: 'app.example.com', type: 5, data: 'target.example.net.' }] }
          : type === 'A'
            ? { Status: 0, Answer: [{ name: 'app.example.com', type: 1, data: '5.6.7.8' }] }
            : { Status: 0 };
        return Promise.resolve(new Response(JSON.stringify(body)) as any);
      });
      const r = await resolveDnsViaDoh('app.example.com');
      expect(r.result).toBe('ok');
      // The CNAME-bearing provider (Google) wins, so we get its cname even
      // though the other provider also resolved positively.
      expect(r.cname).toBe('target.example.net');
    });

    it('returns nxdomain when one provider says NXDOMAIN and the other network_fails (definitive negative wins)', async () => {
      fetchSpy.mockImplementation((url: string) => {
        const u = new URL(url);
        if (u.host === 'cloudflare-dns.com') {
          return Promise.resolve(new Response(JSON.stringify({ Status: 3 })) as any);
        }
        // Google unreachable.
        return Promise.reject(new TypeError('Failed to fetch'));
      });
      const r = await resolveDnsViaDoh('app.example.com');
      expect(r.result).toBe('nxdomain');
    });

    it('returns network_fail only when ALL providers fail', async () => {
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
      const r = await resolveDnsViaDoh('app.example.com');
      expect(r.result).toBe('network_fail');
    });
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
    // Real browsers return an opaque Response (status=0) for cross-origin
    // mode:'no-cors' fetches, but the Response constructor only accepts
    // 200-599 per WHATWG Fetch. happy-dom is lax today; jsdom and real
    // browsers reject status=0. Drop the init arg — `probeHttps` doesn't
    // inspect status anyway (sibling test below covers the 5xx-still-ok
    // contract explicitly).
    fetchSpy.mockResolvedValue(new Response(null) as any);
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
