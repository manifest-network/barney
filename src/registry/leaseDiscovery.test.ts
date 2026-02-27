import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  discoverUnknownLeases,
  enrichDiscoveredLeases,
  _resetEnrichmentInFlight,
} from './leaseDiscovery';
import { getApps, getAppByLease, addApp, type AppEntry } from './appRegistry';
import { LeaseState, type Lease } from '../api/billing';
import type { Provider } from '../api/sku';
import type { LeaseReleasesResponse } from '../api/fred';
import type { LeaseConnectionResponse } from '../api/provider-api';

// Mock dependencies
vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

vi.mock('../api/sku', () => ({
  getProvider: vi.fn(),
  getSKU: vi.fn(),
}));

vi.mock('../api/fred', () => ({
  getLeaseReleases: vi.fn(),
  getLeaseInfo: vi.fn(),
}));

vi.mock('../api/provider-api', () => ({
  getLeaseConnectionInfo: vi.fn(),
  createSignMessage: vi.fn(
    (tenant: string, leaseUuid: string, ts: number) => `${tenant}:${leaseUuid}:${ts}`
  ),
  createAuthToken: vi.fn(() => 'mock-auth-token'),
}));

const { getProvider, getSKU } = await import('../api/sku');
const { getLeaseReleases, getLeaseInfo } = await import('../api/fred');
const { getLeaseConnectionInfo } = await import('../api/provider-api');

const ADDR = 'manifest1test';

function makeLease(overrides: Partial<Lease> = {}): Lease {
  return {
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    tenant: ADDR,
    providerUuid: 'prov-uuid-1',
    items: [{ skuUuid: 'sku-uuid-1', quantity: 1n, serviceName: '' }],
    state: LeaseState.LEASE_STATE_ACTIVE,
    createdAt: new Date('2025-01-01'),
    lastSettledAt: new Date('2025-01-01'),
    rejectionReason: '',
    closureReason: '',
    metaHash: new Uint8Array(),
    ...overrides,
  } as Lease;
}

function makeApp(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    name: 'my-app',
    leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
    size: 'small',
    providerUuid: 'prov-uuid-1',
    providerUrl: 'https://provider.example.com',
    createdAt: Date.now(),
    status: 'running',
    ...overrides,
  };
}

describe('leaseDiscovery', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    _resetEnrichmentInFlight();
  });

  // --- discoverUnknownLeases ---

  describe('discoverUnknownLeases', () => {
    it('discovers leases not in registry and adds skeleton entries', () => {
      const leases = [makeLease({ uuid: 'uuid-aaaa-bbbb-cccc-dddddddddddd' })];

      const discovered = discoverUnknownLeases(ADDR, leases);

      expect(discovered).toEqual(['uuid-aaaa-bbbb-cccc-dddddddddddd']);
      const apps = getApps(ADDR);
      expect(apps).toHaveLength(1);
      expect(apps[0].name).toBe('lease-uuid-aaa');
      expect(apps[0].size).toBe('unknown');
      expect(apps[0].providerUuid).toBe('prov-uuid-1');
      expect(apps[0].providerUrl).toBe('');
      expect(apps[0].status).toBe('running');
    });

    it('skips leases already in registry', () => {
      addApp(ADDR, makeApp({ leaseUuid: 'existing-uuid' }));
      const leases = [makeLease({ uuid: 'existing-uuid' })];

      const discovered = discoverUnknownLeases(ADDR, leases);

      expect(discovered).toEqual([]);
      expect(getApps(ADDR)).toHaveLength(1);
    });

    it('skips CLOSED leases', () => {
      const leases = [makeLease({ state: LeaseState.LEASE_STATE_CLOSED })];

      const discovered = discoverUnknownLeases(ADDR, leases);

      expect(discovered).toEqual([]);
      expect(getApps(ADDR)).toHaveLength(0);
    });

    it('skips REJECTED leases', () => {
      const leases = [makeLease({ state: LeaseState.LEASE_STATE_REJECTED })];

      const discovered = discoverUnknownLeases(ADDR, leases);

      expect(discovered).toEqual([]);
    });

    it('skips EXPIRED leases', () => {
      const leases = [makeLease({ state: LeaseState.LEASE_STATE_EXPIRED })];

      const discovered = discoverUnknownLeases(ADDR, leases);

      expect(discovered).toEqual([]);
    });

    it('sets deploying status for PENDING leases', () => {
      const leases = [makeLease({
        uuid: 'pending-uuid-1234-5678-abcdef123456',
        state: LeaseState.LEASE_STATE_PENDING,
      })];

      discoverUnknownLeases(ADDR, leases);

      const apps = getApps(ADDR);
      expect(apps[0].status).toBe('deploying');
    });

    it('handles name collisions with numeric suffix', () => {
      // Pre-populate with a conflicting name
      addApp(ADDR, makeApp({ name: 'lease-uuid-aaa', leaseUuid: 'other-uuid' }));

      const leases = [makeLease({ uuid: 'uuid-aaaa-bbbb-cccc-dddddddddddd' })];
      discoverUnknownLeases(ADDR, leases);

      const apps = getApps(ADDR);
      expect(apps).toHaveLength(2);
      const names = apps.map((a) => a.name);
      expect(names).toContain('lease-uuid-aaa');
      expect(names).toContain('lease-uuid-aaa-2');
    });

    it('discovers multiple leases at once', () => {
      const leases = [
        makeLease({ uuid: 'uuid-1111-2222-3333-444444444444' }),
        makeLease({ uuid: 'uuid-5555-6666-7777-888888888888', providerUuid: 'prov-2' }),
      ];

      const discovered = discoverUnknownLeases(ADDR, leases);

      expect(discovered).toHaveLength(2);
      expect(getApps(ADDR)).toHaveLength(2);
    });
  });

  // --- enrichDiscoveredLeases ---

  describe('enrichDiscoveredLeases', () => {
    const mockSignArbitrary = vi.fn().mockResolvedValue({
      pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'mockPubKey' },
      signature: 'mockSignature',
    });

    it('fetches provider URL and updates entry', async () => {
      const lease = makeLease({ uuid: 'enrich-uuid-1' });
      addApp(ADDR, makeApp({
        name: 'lease-enrich-u',
        leaseUuid: 'enrich-uuid-1',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1',
        apiUrl: 'https://fred.example.com',
        address: 'manifest1provider',
        payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(),
        active: true,
      } satisfies Provider);

      (getSKU as Mock).mockResolvedValue({
        uuid: 'sku-uuid-1',
        name: 'docker-micro',
        providerUuid: 'prov-uuid-1',
        active: true,
        basePrice: { denom: 'upwr', amount: '100' },
        unit: 0,
      });

      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'enrich-uuid-1',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        releases: [],
      } satisfies LeaseReleasesResponse);

      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('no connection'));

      const leaseMap = new Map([['enrich-uuid-1', lease]]);
      await enrichDiscoveredLeases(ADDR, ['enrich-uuid-1'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'enrich-uuid-1');
      expect(app?.providerUrl).toBe('https://fred.example.com');
      expect(app?.size).toBe('micro');
    });

    it('derives name from release image', async () => {
      const lease = makeLease({ uuid: 'name-uuid-1' });
      addApp(ADDR, makeApp({
        name: 'lease-name-uui',
        leaseUuid: 'name-uuid-1',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1',
        apiUrl: 'https://fred.example.com',
        address: 'manifest1provider',
        payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(),
        active: true,
      });

      (getSKU as Mock).mockResolvedValue({
        uuid: 'sku-uuid-1',
        name: 'docker-small',
        providerUuid: 'prov-uuid-1',
        active: true,
        basePrice: { denom: 'upwr', amount: '100' },
        unit: 0,
      });

      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'name-uuid-1',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        releases: [
          { version: 1, image: 'redis:8.4', status: 'active', created_at: '2025-01-01T00:00:00Z' },
        ],
      } satisfies LeaseReleasesResponse);

      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('no connection'));

      const leaseMap = new Map([['name-uuid-1', lease]]);
      await enrichDiscoveredLeases(ADDR, ['name-uuid-1'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'name-uuid-1');
      expect(app?.name).toBe('redis');
    });

    it('handles missing signArbitrary gracefully (only fetches provider URL)', async () => {
      const lease = makeLease({ uuid: 'no-sign-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-no-sign-',
        leaseUuid: 'no-sign-uuid',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1',
        apiUrl: 'https://fred.example.com',
        address: 'manifest1provider',
        payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(),
        active: true,
      });

      (getSKU as Mock).mockResolvedValue({
        uuid: 'sku-uuid-1',
        name: 'docker-micro',
        providerUuid: 'prov-uuid-1',
        active: true,
        basePrice: { denom: 'upwr', amount: '100' },
        unit: 0,
      });

      const leaseMap = new Map([['no-sign-uuid', lease]]);
      // No signArbitrary passed
      await enrichDiscoveredLeases(ADDR, ['no-sign-uuid'], leaseMap);

      const app = getAppByLease(ADDR, 'no-sign-uuid');
      expect(app?.providerUrl).toBe('https://fred.example.com');
      expect(app?.size).toBe('micro');
      // Should not have called Fred APIs
      expect(getLeaseReleases).not.toHaveBeenCalled();
      expect(getLeaseConnectionInfo).not.toHaveBeenCalled();
    });

    it('handles Fred API errors without throwing', async () => {
      const lease = makeLease({ uuid: 'error-uuid-1' });
      addApp(ADDR, makeApp({
        name: 'lease-error-uu',
        leaseUuid: 'error-uuid-1',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1',
        apiUrl: 'https://fred.example.com',
        address: 'manifest1provider',
        payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(),
        active: true,
      });

      (getSKU as Mock).mockRejectedValue(new Error('SKU not found'));
      (getLeaseReleases as Mock).mockRejectedValue(new Error('Fred error'));
      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('Fred error'));
      (getLeaseInfo as Mock).mockRejectedValue(new Error('Fred error'));

      const leaseMap = new Map([['error-uuid-1', lease]]);

      // Should not throw
      await expect(
        enrichDiscoveredLeases(ADDR, ['error-uuid-1'], leaseMap, mockSignArbitrary)
      ).resolves.toBeUndefined();

      // Should still have updated providerUrl
      const app = getAppByLease(ADDR, 'error-uuid-1');
      expect(app?.providerUrl).toBe('https://fred.example.com');
    });

    it('limits concurrent enrichment to batch size', async () => {
      const leases: Lease[] = [];
      const uuids: string[] = [];
      const leaseMap = new Map<string, Lease>();

      // Create 5 leases (should process in 2 batches: 3 + 2)
      for (let i = 0; i < 5; i++) {
        const uuid = `batch-uuid-${i}`;
        const lease = makeLease({ uuid });
        leases.push(lease);
        uuids.push(uuid);
        leaseMap.set(uuid, lease);
        addApp(ADDR, makeApp({
          name: `lease-batch-uu-${i}`,
          leaseUuid: uuid,
          providerUrl: '',
        }));
      }

      let maxConcurrent = 0;
      let currentConcurrent = 0;

      (getProvider as Mock).mockImplementation(async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 10));
        currentConcurrent--;
        return {
          uuid: 'prov-uuid-1',
          apiUrl: 'https://fred.example.com',
          address: 'manifest1provider',
          payoutAddress: 'manifest1payout',
          metaHash: new Uint8Array(),
          active: true,
        };
      });

      (getSKU as Mock).mockResolvedValue(null);

      await enrichDiscoveredLeases(ADDR, uuids, leaseMap);

      // Should never exceed LEASE_DISCOVERY_MAX_CONCURRENT (3)
      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });

    it('prevents duplicate enrichment of the same lease', async () => {
      const lease = makeLease({ uuid: 'dup-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-dup-uuid',
        leaseUuid: 'dup-uuid',
        providerUrl: '',
      }));

      let resolveFirst: () => void;
      const firstCallPromise = new Promise<void>((r) => { resolveFirst = r; });

      (getProvider as Mock).mockImplementation(async () => {
        await firstCallPromise;
        return {
          uuid: 'prov-uuid-1',
          apiUrl: 'https://fred.example.com',
          address: 'manifest1provider',
          payoutAddress: 'manifest1payout',
          metaHash: new Uint8Array(),
          active: true,
        };
      });

      (getSKU as Mock).mockResolvedValue(null);

      const leaseMap = new Map([['dup-uuid', lease]]);

      // Start first enrichment (will block on getProvider)
      const first = enrichDiscoveredLeases(ADDR, ['dup-uuid'], leaseMap);
      // Start second enrichment while first is in flight
      const second = enrichDiscoveredLeases(ADDR, ['dup-uuid'], leaseMap);

      // Second should complete immediately (filtered out)
      await second;

      // First call should still be pending
      resolveFirst!();
      await first;

      // getProvider should only be called once (from the first enrichment)
      expect(getProvider).toHaveBeenCalledTimes(1);
    });

    it('stores connection details from getLeaseConnectionInfo', async () => {
      const lease = makeLease({ uuid: 'conn-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-conn-uui',
        leaseUuid: 'conn-uuid',
        providerUrl: '',
      }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1',
        apiUrl: 'https://fred.example.com',
        address: 'manifest1provider',
        payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(),
        active: true,
      });

      (getSKU as Mock).mockResolvedValue(null);

      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'conn-uuid',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        releases: [],
      });

      (getLeaseConnectionInfo as Mock).mockResolvedValue({
        lease_uuid: 'conn-uuid',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        connection: {
          host: '192.168.1.1',
          fqdn: 'myapp.provider.com',
          ports: { '8080/tcp': { host_ip: '0.0.0.0', host_port: 30001 } },
          instances: [{ instance_index: 0, container_id: 'abc', image: 'redis:8.4', status: 'running', fqdn: 'myapp.provider.com' }],
        },
      } satisfies LeaseConnectionResponse);

      const leaseMap = new Map([['conn-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['conn-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'conn-uuid');
      expect(app?.connection?.host).toBe('192.168.1.1');
      expect(app?.connection?.fqdn).toBe('myapp.provider.com');
      expect(app?.connection?.ports).toBeDefined();
    });
  });
});
