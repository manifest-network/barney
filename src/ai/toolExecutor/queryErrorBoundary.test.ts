import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool } from './index';
import { makeRegistry } from './testHelpers';
import { FAILURE_DETAIL_CHARS } from './helpers';
import { providerFetch } from '../../api/providerFetchAdapter';
import { getReadClient } from '../../api/readClient';
import { PROVISION_STATUS_CHARS } from '../../utils/sanitizeText';
import type { SigningContext, ToolExecutorOptions } from './types';

vi.mock('../../api/providerFetchAdapter', () => ({ providerFetch: vi.fn() }));
vi.mock('../../api/readClient', () => ({ getReadClient: vi.fn() }));
vi.mock('../../utils/errors', async (original) => ({ ...await original<typeof import('../../utils/errors')>(), logError: vi.fn() }));
vi.mock('../../api/faucet', async (original) => ({
  ...await original<typeof import('../../api/faucet')>(),
  isFaucetEnabled: () => true,
  getFaucetBaseUrl: () => 'https://faucet.example.com',
  FAUCET_COOLDOWN_HOURS: 24,
}));

const app = {
  name: 'web', leaseUuid: '550e8400-e29b-41d4-a716-446655440000', providerUuid: 'provider-1',
  providerUrl: 'https://provider.example.com', size: 'small', createdAt: 0,
  status: 'running' as const, chainState: 'active' as const, provisionState: 'confirmed' as const,
};
const address = 'manifest1query';
const getAuthToken = vi.fn();
const options = (): ToolExecutorOptions => ({ address, clientManager: null, tiers: [], appRegistry: makeRegistry([app]),
  signing: { authTokens: { getAuthToken } } as unknown as SigningContext });
const queries = [['get_logs', 'logs'], ['app_diagnostics', 'diagnostics'], ['app_releases', 'releases']] as const;

beforeEach(() => {
  vi.clearAllMocks();
  getAuthToken.mockResolvedValue('query-token');
});
afterEach(() => vi.unstubAllGlobals());

describe('query error display boundaries', () => {
  it.each(queries)('bounds a real SDK HTTP error body through %s', async (tool, subject) => {
    const body = `<html>\n<body>\r\nBad gateway\u0000\u202e\u2028\u2029\t${'🦕'.repeat(2_500)}\n</body>\n</html>`;
    vi.mocked(providerFetch).mockResolvedValueOnce(new Response(body, { status: 502, headers: { 'content-type': 'text/html' } }));

    const result = await executeTool(tool, { app_name: app.name }, options());

    expect(result.success).toBe(false);
    expect(providerFetch).toHaveBeenCalledOnce();
    const prefix = `Failed to fetch ${subject} for "web": `;
    expect(result.error).toContain(prefix);
    const detail = result.error!.slice(prefix.length);
    expect(detail).toContain('<html> <body> Bad gateway');
    expect(detail).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(Array.from(detail)).toHaveLength(FAILURE_DETAIL_CHARS + 1);
    expect(detail.endsWith('…')).toBe(true);
    expect(detail).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it.each(queries)('bounds signing failures before %s without contacting the provider', async (tool) => {
    getAuthToken.mockRejectedValueOnce(new Error(`Wallet rejected\nrequest\u0000\u202e\t${'x'.repeat(2_000)}`));
    const result = await executeTool(tool, { app_name: app.name }, options());
    const prefix = 'Failed to sign request: ';
    expect(result.error).toContain(`${prefix}Wallet rejected request `);
    expect(result.error).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(Array.from(result.error!.slice(prefix.length))).toHaveLength(FAILURE_DETAIL_CHARS + 1);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('preserves successful multiline logs in the tool data and full LogCard', async () => {
    const logs = { web: 'first line\n  indented second line\n\nlast line\n', worker: 'worker ready\njob completed\n' };
    vi.mocked(providerFetch).mockResolvedValueOnce(Response.json({
      lease_uuid: app.leaseUuid, tenant: address, provider_uuid: app.providerUuid, logs,
    }));
    const result = await executeTool('get_logs', { app_name: app.name }, options());
    expect(result).toMatchObject({ success: true, data: { logs }, displayCard: { type: 'logs', data: { logs } } });
  });

  it('bounds failure fields in real SDK release history while preserving release facts', async () => {
    const raw = `Provider detail\n\u0000\u202e${'🦕'.repeat(1_000)}`;
    vi.mocked(providerFetch).mockResolvedValueOnce(Response.json({
      lease_uuid: app.leaseUuid, tenant: address, provider_uuid: app.providerUuid,
      releases: [{ version: 3, image: 'nginx:latest', status: 'failed', created_at: '2026-01-01',
        reason: raw, message: raw, error: raw, last_error: raw, manifest: 'secret manifest' }],
    }));

    const result = await executeTool('app_releases', { app_name: app.name }, options());
    expect(result.success).toBe(true);
    const data = result.data as { count: number; releases: Record<string, unknown>[] };
    expect(data.count).toBe(1);
    expect(data.releases[0]).toMatchObject({ version: 3, image: 'nginx:latest', status: 'failed', created_at: '2026-01-01' });
    expect(data.releases[0]).not.toHaveProperty('manifest');
    for (const field of ['reason', 'message', 'error', 'last_error']) {
      const value = data.releases[0][field] as string;
      expect(value).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(value).not.toMatch(/[\uD800-\uDFFF]/u);
      expect(Array.from(value)).toHaveLength((field === 'reason' ? 64 : FAILURE_DETAIL_CHARS) + 1);
      expect(value.endsWith('…')).toBe(true);
    }
  });

  it('bounds an unmodelled provision status in real SDK diagnostic output', async () => {
    const raw = `future\n\u0000\u202e${'🦕'.repeat(1_000)}`;
    vi.mocked(providerFetch).mockResolvedValueOnce(Response.json({ status: raw, fail_count: 7 }));
    const result = await executeTool('app_diagnostics', { app_name: app.name }, options());
    expect(result.success).toBe(true);
    const data = result.data as { status: string; fail_count: number };
    expect(data.fail_count).toBe(7);
    expect(data.status.startsWith('future ')).toBe(true);
    expect(data.status).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(data.status).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(Array.from(data.status)).toHaveLength(PROVISION_STATUS_CHARS + 1);
  });

  it('bounds chain closure and rejection reasons through the lease-history query path', async () => {
    const raw = `Rejected\n\u0000\u202e${'🦕'.repeat(1_000)}`;
    const lease = { uuid: app.leaseUuid, state: 4, closureReason: raw, rejectionReason: raw };
    const getLeasesByTenant = vi.fn().mockResolvedValue({ leases: [lease], total: 1n });
    vi.mocked(getReadClient).mockResolvedValue({ getLeasesByTenant } as unknown as Awaited<ReturnType<typeof getReadClient>>);

    const result = await executeTool('lease_history', {}, options());
    expect(result.success).toBe(true);
    const data = result.data as { leases: { state: string; closureReason: string; rejectionReason: string }[]; count: number; total: number };
    expect(data).toMatchObject({ count: 1, total: 1, leases: [{ state: 'Rejected' }] });
    for (const value of [data.leases[0].closureReason, data.leases[0].rejectionReason]) {
      expect(value).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(value).not.toMatch(/[\uD800-\uDFFF]/u);
      expect(Array.from(value)).toHaveLength(FAILURE_DETAIL_CHARS + 1);
    }
    expect(lease.closureReason).toBe(raw);
    expect(lease.rejectionReason).toBe(raw);
  });
});

describe('faucet returned-error display boundaries', () => {
  const denoms = ['umfx', 'factory/addr/upwr'];
  const body = `<html>\n<body>\r\nWAF denied\u0000\u202e\u2028\u2029\t${'🦕'.repeat(2_500)}\n</body>\n</html>`;
  const prefix = '<html> <body> WAF denied ';
  const detail = `${prefix}${'🦕'.repeat(FAILURE_DETAIL_CHARS - Array.from(prefix).length)}…`;

  function faucetHttp(successfulDenoms: string[]) {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith('/status')) {
        return Response.json({
          status: 'ok', nodeUrl: 'https://rpc.example.com', chainId: 'manifest-test',
          chainTokens: denoms, availableTokens: denoms,
          holder: { address: 'manifest1holder', balance: [] }, distributors: [],
        });
      }
      const request = JSON.parse(String(init?.body)) as { address: string; denom: string };
      expect(String(input)).toBe('https://faucet.example.com/credit');
      expect(init?.method).toBe('POST');
      expect(request.address).toBe(address);
      expect(denoms).toContain(request.denom);
      return successfulDenoms.includes(request.denom)
        ? new Response('credited\nreceipt', { status: 200 })
        : new Response(body, { status: 503, headers: { 'content-type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('bounds real SDK non-2xx bodies when every credit fails', async () => {
    const fetch = faucetHttp([]);
    const result = await executeTool('request_faucet', {}, options());

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      success: false,
      error: `Faucet request failed for all tokens. 24-hour cooldown may be active. Details: umfx: ${detail}; factory/addr/upwr: ${detail}`,
    });
    expect(result.error).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(result.error).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(Array.from(detail)).toHaveLength(FAILURE_DETAIL_CHARS + 1);
  });

  it('shares bounded failed details between mixed-result prose and rows, preserving successful rows', async () => {
    const fetch = faucetHttp(['umfx']);
    const result = await executeTool('request_faucet', {}, options());

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      success: true,
      data: {
        message: `Partial success: received umfx. Failed: factory/addr/upwr (${detail}). 24-hour cooldown may be active for failed tokens.`,
        results: [
          { denom: 'umfx', success: true },
          { denom: 'factory/addr/upwr', success: false, error: detail },
        ],
      },
    });
    expect(JSON.stringify(result.data)).not.toContain('\\n');
    expect(JSON.stringify(result.data)).not.toMatch(/[\p{Cf}\p{Zl}\p{Zp}]/u);
  });

  it('preserves real SDK successful credit results and success wording', async () => {
    const fetch = faucetHttp(denoms);
    const result = await executeTool('request_faucet', {}, options());

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      success: true,
      data: {
        message: 'Tokens sent! You received PWR (gas + credits) and MFX.',
        results: denoms.map((denom) => ({ denom, success: true })),
      },
    });
  });
});
