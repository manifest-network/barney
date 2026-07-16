import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryLeaseByCustomDomain } from './leaseByCustomDomain';

const { mockGetLeaseByCustomDomain } = vi.hoisted(() => ({
  mockGetLeaseByCustomDomain: vi.fn(),
}));

// ENG-536/537: queryLeaseByCustomDomain rides the read client's typed
// getLeaseByCustomDomain — returns { lease, serviceName } | null (null on
// NOT_FOUND, throw on a transport failure), numeric enums decoded internally.
vi.mock('./readClient', () => ({
  getReadClient: vi.fn().mockResolvedValue({
    getLeaseByCustomDomain: (...a: unknown[]) => mockGetLeaseByCustomDomain(...a),
  }),
}));

describe('queryLeaseByCustomDomain', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when the FQDN is unclaimed (NOT_FOUND)', async () => {
    mockGetLeaseByCustomDomain.mockResolvedValue(null);
    const result = await queryLeaseByCustomDomain('app.example.com');
    expect(result).toBeNull();
  });

  it('returns lease + serviceName + leaseUuid on hit', async () => {
    mockGetLeaseByCustomDomain.mockResolvedValue({
      lease: {
        uuid: 'lease-uuid-1',
        tenant: 'tenant-addr',
        providerUuid: 'provider-1',
        items: [],
        state: 2,
        createdAt: new Date(),
      },
      serviceName: 'web',
    });

    const result = await queryLeaseByCustomDomain('app.example.com');
    expect(result).not.toBeNull();
    expect(result?.leaseUuid).toBe('lease-uuid-1');
    expect(result?.serviceName).toBe('web');
    expect(result?.lease.uuid).toBe('lease-uuid-1');
  });

  it('rethrows a transport failure instead of treating it as not-found', async () => {
    mockGetLeaseByCustomDomain.mockRejectedValue(new Error('server error'));
    await expect(queryLeaseByCustomDomain('app.example.com')).rejects.toThrow('server error');
  });

  it('forwards the fqdn to the read client', async () => {
    mockGetLeaseByCustomDomain.mockResolvedValue(null);
    await queryLeaseByCustomDomain('hello.example.com');
    expect(mockGetLeaseByCustomDomain).toHaveBeenCalledWith('hello.example.com');
  });
});
