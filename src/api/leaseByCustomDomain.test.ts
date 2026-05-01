import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryLeaseByCustomDomain } from './leaseByCustomDomain';

vi.mock('./queryClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./queryClient')>();
  const mockLeaseByCustomDomain = vi.fn();
  return {
    ...actual,
    getQueryClient: vi.fn().mockResolvedValue({
      liftedinit: {
        billing: {
          v1: {
            leaseByCustomDomain: mockLeaseByCustomDomain,
          },
        },
      },
    }),
    queryWithNotFound: vi.fn(async (fn, fallback) => {
      try {
        return await fn();
      } catch {
        return fallback;
      }
    }),
    lcdConvert: vi.fn((data) => data),
    fixEnumField: vi.fn((obj) => obj),
  };
});

import { getQueryClient } from './queryClient';

describe('queryLeaseByCustomDomain', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when chain returns NotFound', async () => {
    const client = await getQueryClient();
    vi.mocked(client.liftedinit.billing.v1.leaseByCustomDomain).mockRejectedValue(
      Object.assign(new Error('not found'), { response: { status: 404 } }),
    );
    const result = await queryLeaseByCustomDomain('app.example.com');
    expect(result).toBeNull();
  });

  it('returns lease + serviceName + leaseUuid on hit', async () => {
    const client = await getQueryClient();
    vi.mocked(client.liftedinit.billing.v1.leaseByCustomDomain).mockResolvedValue({
      lease: {
        uuid: 'lease-uuid-1',
        tenant: 'tenant-addr',
        providerUuid: 'provider-1',
        items: [],
        state: 2,
        createdAt: new Date(),
      },
      serviceName: 'web',
    } as any);

    const result = await queryLeaseByCustomDomain('app.example.com');
    expect(result).not.toBeNull();
    expect(result?.leaseUuid).toBe('lease-uuid-1');
    expect(result?.serviceName).toBe('web');
    expect(result?.lease.uuid).toBe('lease-uuid-1');
  });

  it('forwards custom_domain as customDomain on the request', async () => {
    const client = await getQueryClient();
    vi.mocked(client.liftedinit.billing.v1.leaseByCustomDomain).mockRejectedValue(
      Object.assign(new Error('not found'), { response: { status: 404 } }),
    );
    await queryLeaseByCustomDomain('hello.example.com');
    expect(client.liftedinit.billing.v1.leaseByCustomDomain).toHaveBeenCalledWith({
      customDomain: 'hello.example.com',
    });
  });
});
