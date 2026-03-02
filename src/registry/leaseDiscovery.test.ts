import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  discoverUnknownLeases,
  enrichDiscoveredLeases,
  _resetEnrichmentInFlight,
} from './leaseDiscovery';
import { getApps, getAppByLease, addApp, removeApp, type AppEntry } from './appRegistry';
import { LEASE_DISCOVERY_MAX_CONCURRENT } from '../config/constants';
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

vi.mock('../api/provider-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/provider-api')>();
  return {
    ...actual,
    getLeaseConnectionInfo: vi.fn(),
    createSignMessage: vi.fn(
      (tenant: string, leaseUuid: string, ts: number) => `${tenant}:${leaseUuid}:${ts}`
    ),
    createAuthToken: vi.fn(() => 'mock-auth-token'),
  };
});

vi.mock('../api/providerFetch', () => ({
  validateProviderUrl: vi.fn(),
}));

const { getProvider, getSKU } = await import('../api/sku');
const { getLeaseReleases, getLeaseInfo } = await import('../api/fred');
const { getLeaseConnectionInfo } = await import('../api/provider-api');
const { validateProviderUrl } = await import('../api/providerFetch');

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
      expect(app?.name).toBe('redis-8-4');
    });

    it('handles missing signArbitrary gracefully (fetches provider + SKU only)', async () => {
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

      // Should never exceed LEASE_DISCOVERY_MAX_CONCURRENT
      expect(maxConcurrent).toBeLessThanOrEqual(LEASE_DISCOVERY_MAX_CONCURRENT);
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

    it('allows different wallets to enrich the same lease UUID concurrently', async () => {
      const ADDR2 = 'manifest1other';
      const lease = makeLease({ uuid: 'shared-uuid' });
      addApp(ADDR, makeApp({ name: 'lease-shared-u', leaseUuid: 'shared-uuid', providerUrl: '' }));
      addApp(ADDR2, makeApp({ name: 'lease-shared-u', leaseUuid: 'shared-uuid', providerUrl: '' }));

      let resolveGate: () => void;
      const gate = new Promise<void>((r) => { resolveGate = r; });

      (getProvider as Mock).mockImplementation(async () => {
        await gate;
        return {
          uuid: 'prov-uuid-1', apiUrl: 'https://fred.example.com',
          address: 'manifest1provider', payoutAddress: 'manifest1payout',
          metaHash: new Uint8Array(), active: true,
        };
      });
      (getSKU as Mock).mockResolvedValue(null);

      const leaseMap = new Map([['shared-uuid', lease]]);

      // Both wallets enrich the same lease UUID concurrently
      const first = enrichDiscoveredLeases(ADDR, ['shared-uuid'], leaseMap);
      const second = enrichDiscoveredLeases(ADDR2, ['shared-uuid'], leaseMap);

      resolveGate!();
      await Promise.all([first, second]);

      // getProvider should be called twice — once per wallet (not blocked)
      expect(getProvider).toHaveBeenCalledTimes(2);
    });

    it('assigns unique names when multiple leases derive the same image', async () => {
      const lease1 = makeLease({ uuid: 'dup-img-uuid-1' });
      const lease2 = makeLease({ uuid: 'dup-img-uuid-2' });
      addApp(ADDR, makeApp({ name: 'lease-dup-img-', leaseUuid: 'dup-img-uuid-1', providerUrl: '', size: 'unknown' }));
      addApp(ADDR, makeApp({ name: 'lease-dup-img', leaseUuid: 'dup-img-uuid-2', providerUrl: '', size: 'unknown' }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1', apiUrl: 'https://fred.example.com',
        address: 'manifest1provider', payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(), active: true,
      });
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: '', tenant: ADDR, provider_uuid: 'prov-uuid-1',
        releases: [{ version: 1, image: 'redis:8.4', status: 'active', created_at: '2025-01-01T00:00:00Z' }],
      } satisfies LeaseReleasesResponse);
      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('no connection'));

      const leaseMap = new Map([['dup-img-uuid-1', lease1], ['dup-img-uuid-2', lease2]]);
      await enrichDiscoveredLeases(ADDR, ['dup-img-uuid-1', 'dup-img-uuid-2'], leaseMap, mockSignArbitrary);

      const app1 = getAppByLease(ADDR, 'dup-img-uuid-1');
      const app2 = getAppByLease(ADDR, 'dup-img-uuid-2');
      const names = new Set([app1?.name, app2?.name]);
      expect(names).toEqual(new Set(['redis-8-4', 'redis-8-4-2']));
    });

    it('truncates long derived names to fit within 32-char limit', async () => {
      // Image name that produces a 32-char derived name
      const longImage = 'my-very-long-application-name-ab:latest'; // derives "my-very-long-application-name-ab" (32 chars)
      const lease = makeLease({ uuid: 'long-name-uuid' });
      // Pre-add a conflicting entry so uniquifyName must append a suffix
      addApp(ADDR, makeApp({ name: 'my-very-long-application-name-ab', leaseUuid: 'conflict-uuid' }));
      // Also conflict with the truncated base to force numeric suffix
      addApp(ADDR, makeApp({ name: 'my-very-long-application-nam', leaseUuid: 'conflict-uuid-2' }));
      addApp(ADDR, makeApp({ name: 'lease-long-nam', leaseUuid: 'long-name-uuid', providerUrl: '', size: 'unknown' }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1', apiUrl: 'https://fred.example.com',
        address: 'manifest1provider', payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(), active: true,
      });
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'long-name-uuid', tenant: ADDR, provider_uuid: 'prov-uuid-1',
        releases: [{ version: 1, image: longImage, status: 'active', created_at: '2025-01-01T00:00:00Z' }],
      } satisfies LeaseReleasesResponse);
      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('no connection'));

      const leaseMap = new Map([['long-name-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['long-name-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'long-name-uuid');
      expect(app?.name).toBeDefined();
      expect(app!.name.length).toBeLessThanOrEqual(32);
      // Truncated base and its bare form are both taken, so gets numeric suffix
      expect(app!.name).toMatch(/-\d+$/);
    });

    it('uses truncated base directly when only the full-length name conflicts', async () => {
      const longImage = 'my-very-long-application-name-ab:latest'; // derives 32-char name
      const lease = makeLease({ uuid: 'trunc-uuid-1' });
      // Only the full 32-char name conflicts — truncated base is available
      addApp(ADDR, makeApp({ name: 'my-very-long-application-name-ab', leaseUuid: 'conflict-uuid' }));
      addApp(ADDR, makeApp({ name: 'lease-trunc-uu', leaseUuid: 'trunc-uuid-1', providerUrl: '', size: 'unknown' }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1', apiUrl: 'https://fred.example.com',
        address: 'manifest1provider', payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(), active: true,
      });
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'trunc-uuid-1', tenant: ADDR, provider_uuid: 'prov-uuid-1',
        releases: [{ version: 1, image: longImage, status: 'active', created_at: '2025-01-01T00:00:00Z' }],
      } satisfies LeaseReleasesResponse);
      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('no connection'));

      const leaseMap = new Map([['trunc-uuid-1', lease]]);
      await enrichDiscoveredLeases(ADDR, ['trunc-uuid-1'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'trunc-uuid-1');
      // Should use truncated base directly without numeric suffix
      expect(app?.name).toBe('my-very-long-application-nam');
    });

    it('strips trailing hyphens from truncated names', async () => {
      // Image that produces a name with a hyphen at the truncation boundary
      // "abcdefghijklmnopqrstuvwxyz-ab" is 29 chars; truncation at 28 → "abcdefghijklmnopqrstuvwxyz-a"
      // But we need hyphens at position 28 for the bug. Let's construct it:
      // The image "aaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd:latest" derives to "aaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd" (31 chars)
      // Truncate to 28: "aaaaaaaaaaaaaaaaaaaaaaaaaaa-" → trailing hyphen → stripped to "aaaaaaaaaaaaaaaaaaaaaaaaaaa"
      const lease = makeLease({ uuid: 'hyphen-uuid-1' });
      // Pre-add a conflicting entry to force truncation path
      addApp(ADDR, makeApp({ name: 'aaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd', leaseUuid: 'conflict-uuid-2' }));
      addApp(ADDR, makeApp({ name: 'lease-hyphen-u', leaseUuid: 'hyphen-uuid-1', providerUrl: '', size: 'unknown' }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1', apiUrl: 'https://fred.example.com',
        address: 'manifest1provider', payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(), active: true,
      });
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'hyphen-uuid-1', tenant: ADDR, provider_uuid: 'prov-uuid-1',
        releases: [{ version: 1, image: 'aaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd:latest', status: 'active', created_at: '2025-01-01T00:00:00Z' }],
      } satisfies LeaseReleasesResponse);
      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('no connection'));

      const leaseMap = new Map([['hyphen-uuid-1', lease]]);
      await enrichDiscoveredLeases(ADDR, ['hyphen-uuid-1'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'hyphen-uuid-1');
      expect(app?.name).toBeDefined();
      // Name must not contain double hyphens or start/end with hyphens
      expect(app!.name).not.toMatch(/--/);
      expect(app!.name).not.toMatch(/^-/);
      expect(app!.name).not.toMatch(/-$/);
      expect(app!.name.length).toBeLessThanOrEqual(32);
    });

    it('falls back to getLeaseInfo when getLeaseConnectionInfo fails', async () => {
      const lease = makeLease({ uuid: 'fallback-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-fallback',
        leaseUuid: 'fallback-uuid',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1', apiUrl: 'https://fred.example.com',
        address: 'manifest1provider', payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(), active: true,
      });
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'fallback-uuid', tenant: ADDR, provider_uuid: 'prov-uuid-1',
        releases: [],
      } satisfies LeaseReleasesResponse);
      // getLeaseConnectionInfo fails → triggers fallback
      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('connection unavailable'));
      // getLeaseInfo succeeds as fallback
      (getLeaseInfo as Mock).mockResolvedValue({
        host: '10.0.0.1',
        ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 30080 } },
      });

      const leaseMap = new Map([['fallback-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['fallback-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'fallback-uuid');
      expect(app?.connection?.host).toBe('10.0.0.1');
      expect(app?.connection?.ports).toEqual({ '80/tcp': { host_ip: '0.0.0.0', host_port: 30080 } });
      expect(getLeaseInfo).toHaveBeenCalledTimes(1);
    });

    it('stores manifest from release and sanitizes it', async () => {
      const lease = makeLease({ uuid: 'manifest-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-manifest',
        leaseUuid: 'manifest-uuid',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1', apiUrl: 'https://fred.example.com',
        address: 'manifest1provider', payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(), active: true,
      });
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'manifest-uuid', tenant: ADDR, provider_uuid: 'prov-uuid-1',
        releases: [{
          version: 1,
          image: 'redis:8.4',
          status: 'active',
          created_at: '2025-01-01T00:00:00Z',
          manifest: '{"image":"redis:8.4","ports":["6379/tcp"]}',
        }],
      } satisfies LeaseReleasesResponse);
      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('no connection'));

      const leaseMap = new Map([['manifest-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['manifest-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'manifest-uuid');
      expect(app?.manifest).toBeDefined();
      const parsed = JSON.parse(app!.manifest!);
      expect(parsed.image).toBe('redis:8.4');
    });

    it('handles invalid manifest JSON without crashing', async () => {
      const { logError } = await import('../utils/errors');
      const lease = makeLease({ uuid: 'bad-manifest-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-bad-mani',
        leaseUuid: 'bad-manifest-uuid',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1', apiUrl: 'https://fred.example.com',
        address: 'manifest1provider', payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(), active: true,
      });
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'bad-manifest-uuid', tenant: ADDR, provider_uuid: 'prov-uuid-1',
        releases: [{
          version: 1,
          image: 'redis:8.4',
          status: 'active',
          created_at: '2025-01-01T00:00:00Z',
          manifest: 'not-valid-json{{{',
        }],
      } satisfies LeaseReleasesResponse);
      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('no connection'));

      const leaseMap = new Map([['bad-manifest-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['bad-manifest-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'bad-manifest-uuid');
      // Should still enrich other fields (name) without crashing
      expect(app?.name).toBe('redis-8-4');
      expect(app?.manifest).toBeUndefined();
      expect(logError).toHaveBeenCalledWith(
        'leaseDiscovery.fetchLeaseData.parseManifest',
        expect.any(SyntaxError),
      );
    });

    it('logs error when lease UUID is not found in leaseMap', async () => {
      const { logError } = await import('../utils/errors');
      addApp(ADDR, makeApp({
        name: 'lease-missing',
        leaseUuid: 'missing-map-uuid',
        providerUrl: '',
        size: 'unknown',
      }));

      const leaseMap = new Map<string, Lease>(); // empty — UUID not present
      await enrichDiscoveredLeases(ADDR, ['missing-map-uuid'], leaseMap, mockSignArbitrary);

      expect(logError).toHaveBeenCalledWith(
        'leaseDiscovery.enrichDiscoveredLeases',
        expect.objectContaining({ message: expect.stringContaining('missing-map-uuid') }),
      );
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

    it('logs error and skips Fred calls when signArbitrary throws', async () => {
      const { logError } = await import('../utils/errors');
      const failingSign = vi.fn().mockRejectedValue(new Error('Wallet locked'));
      const lease = makeLease({ uuid: 'sign-fail-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-sign-fai',
        leaseUuid: 'sign-fail-uuid',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1', apiUrl: 'https://fred.example.com',
        address: 'manifest1provider', payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(), active: true,
      });
      (getSKU as Mock).mockResolvedValue(null);

      const leaseMap = new Map([['sign-fail-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['sign-fail-uuid'], leaseMap, failingSign);

      // Provider URL should still be updated
      const app = getAppByLease(ADDR, 'sign-fail-uuid');
      expect(app?.providerUrl).toBe('https://fred.example.com');
      // Fred APIs should not have been called (auth failed)
      expect(getLeaseReleases).not.toHaveBeenCalled();
      expect(getLeaseConnectionInfo).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledWith(
        'leaseDiscovery.fetchLeaseData.getAuthToken',
        expect.any(Error),
      );
    });

    it('logs error when entry is removed between discovery and enrichment', async () => {
      const { logError } = await import('../utils/errors');
      const lease = makeLease({ uuid: 'removed-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-removed-',
        leaseUuid: 'removed-uuid',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockImplementation(async () => {
        // Simulate the entry being removed while enrichment is in flight
        removeApp(ADDR, 'removed-uuid');
        return {
          uuid: 'prov-uuid-1', apiUrl: 'https://fred.example.com',
          address: 'manifest1provider', payoutAddress: 'manifest1payout',
          metaHash: new Uint8Array(), active: true,
        };
      });
      (getSKU as Mock).mockResolvedValue(null);

      const leaseMap = new Map([['removed-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['removed-uuid'], leaseMap);

      expect(logError).toHaveBeenCalledWith(
        'leaseDiscovery.enrichDiscoveredLeases.updateApp',
        expect.objectContaining({ message: expect.stringContaining('removed-uuid') }),
      );
    });

    it('skips SKU fetch when lease has no items', async () => {
      const lease = makeLease({ uuid: 'no-items-enrich', items: [] });
      addApp(ADDR, makeApp({
        name: 'lease-no-items',
        leaseUuid: 'no-items-enrich',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1', apiUrl: 'https://fred.example.com',
        address: 'manifest1provider', payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(), active: true,
      });

      const leaseMap = new Map([['no-items-enrich', lease]]);
      await enrichDiscoveredLeases(ADDR, ['no-items-enrich'], leaseMap);

      expect(getSKU).not.toHaveBeenCalled();
      const app = getAppByLease(ADDR, 'no-items-enrich');
      expect(app?.providerUrl).toBe('https://fred.example.com');
      expect(app?.size).toBe('unknown');
    });

    it('handles getProvider returning null gracefully', async () => {
      const lease = makeLease({ uuid: 'null-prov-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-null-pro',
        leaseUuid: 'null-prov-uuid',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue(null);
      (getSKU as Mock).mockResolvedValue({
        uuid: 'sku-uuid-1', name: 'docker-micro',
        providerUuid: 'prov-uuid-1', active: true,
        basePrice: { denom: 'upwr', amount: '100' }, unit: 0,
      });

      const leaseMap = new Map([['null-prov-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['null-prov-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'null-prov-uuid');
      // SKU should still be enriched
      expect(app?.size).toBe('micro');
      // Provider URL remains empty since getProvider returned null
      expect(app?.providerUrl).toBe('');
      // No Fred calls since providerUrl is empty
      expect(getLeaseReleases).not.toHaveBeenCalled();
      expect(getLeaseConnectionInfo).not.toHaveBeenCalled();
    });

    it('handles getProvider returning provider without apiUrl field', async () => {
      const lease = makeLease({ uuid: 'no-field-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-no-field',
        leaseUuid: 'no-field-uuid',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1',
        address: 'manifest1provider',
        payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(),
        active: true,
        // apiUrl intentionally omitted
      });
      (getSKU as Mock).mockResolvedValue(null);

      const leaseMap = new Map([['no-field-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['no-field-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'no-field-uuid');
      expect(app?.providerUrl).toBe('');
      expect(getLeaseReleases).not.toHaveBeenCalled();
    });

    it('skips Fred enrichment when provider has no apiUrl', async () => {
      const lease = makeLease({ uuid: 'no-api-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-no-api-u',
        leaseUuid: 'no-api-uuid',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1', apiUrl: '',
        address: 'manifest1provider', payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(), active: true,
      });
      (getSKU as Mock).mockResolvedValue({
        uuid: 'sku-uuid-1', name: 'docker-micro',
        providerUuid: 'prov-uuid-1', active: true,
        basePrice: { denom: 'upwr', amount: '100' }, unit: 0,
      });

      const leaseMap = new Map([['no-api-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['no-api-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'no-api-uuid');
      // SKU should still be enriched
      expect(app?.size).toBe('micro');
      // Provider URL remains empty, no Fred calls made
      expect(app?.providerUrl).toBe('');
      expect(getLeaseReleases).not.toHaveBeenCalled();
      expect(getLeaseConnectionInfo).not.toHaveBeenCalled();
    });

    // --- Security fix tests ---

    it('rejects provider URL that fails SSRF validation', async () => {
      const { logError } = await import('../utils/errors');
      const lease = makeLease({ uuid: 'ssrf-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-ssrf-uui',
        leaseUuid: 'ssrf-uuid',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue({
        uuid: 'prov-uuid-1',
        apiUrl: 'http://169.254.169.254/metadata',
        address: 'manifest1provider',
        payoutAddress: 'manifest1payout',
        metaHash: new Uint8Array(),
        active: true,
      });

      // validateProviderUrl throws for unsafe URLs
      (validateProviderUrl as Mock).mockImplementation(() => {
        throw new Error('Provider API URL cannot point to private/internal addresses');
      });

      (getSKU as Mock).mockResolvedValue(null);

      const leaseMap = new Map([['ssrf-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['ssrf-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'ssrf-uuid');
      // Provider URL should NOT be stored
      expect(app?.providerUrl).toBe('');
      // Should log the SSRF validation failure
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('unsafeProviderUrl'),
        expect.any(Error),
      );
      // No Fred calls since providerUrl wasn't stored
      expect(getLeaseReleases).not.toHaveBeenCalled();
    });

    it('stores provider URL when SSRF validation passes', async () => {
      const lease = makeLease({ uuid: 'safe-url-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-safe-url',
        leaseUuid: 'safe-url-uuid',
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

      // validateProviderUrl succeeds (no throw)
      (validateProviderUrl as Mock).mockImplementation(() => {});

      (getSKU as Mock).mockResolvedValue(null);

      const leaseMap = new Map([['safe-url-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['safe-url-uuid'], leaseMap);

      const app = getAppByLease(ADDR, 'safe-url-uuid');
      expect(app?.providerUrl).toBe('https://fred.example.com');
    });

    it('sanitizes special characters from SKU name', async () => {
      const lease = makeLease({ uuid: 'sku-sanitize-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-sku-sani',
        leaseUuid: 'sku-sanitize-uuid',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue(null);
      (getSKU as Mock).mockResolvedValue({
        uuid: 'sku-uuid-1',
        name: 'docker-micro<script>alert(1)</script>',
        providerUuid: 'prov-uuid-1',
        active: true,
        basePrice: { denom: 'upwr', amount: '100' },
        unit: 0,
      });

      const leaseMap = new Map([['sku-sanitize-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['sku-sanitize-uuid'], leaseMap);

      const app = getAppByLease(ADDR, 'sku-sanitize-uuid');
      // Only lowercase alphanumeric and hyphens should remain
      expect(app?.size).toBe('microscriptalert1script');
      expect(app?.size).not.toMatch(/[<>()]/);
    });

    it('rejects manifest without image or services fields', async () => {
      const lease = makeLease({ uuid: 'bad-struct-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-bad-stru',
        leaseUuid: 'bad-struct-uuid',
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
      (validateProviderUrl as Mock).mockImplementation(() => {});
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'bad-struct-uuid',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        releases: [{
          version: 1,
          image: 'redis:8.4',
          status: 'active',
          created_at: '2025-01-01T00:00:00Z',
          manifest: '{"env":{"FOO":"bar"}}',
        }],
      } satisfies LeaseReleasesResponse);
      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('no connection'));

      const leaseMap = new Map([['bad-struct-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['bad-struct-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'bad-struct-uuid');
      // Manifest should NOT be stored (no image or services field)
      expect(app?.manifest).toBeUndefined();
      // Name should still be derived from the release image
      expect(app?.name).toBe('redis-8-4');
    });

    it('accepts manifest with valid image field', async () => {
      const lease = makeLease({ uuid: 'good-manifest-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-good-man',
        leaseUuid: 'good-manifest-uuid',
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
      (validateProviderUrl as Mock).mockImplementation(() => {});
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'good-manifest-uuid',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        releases: [{
          version: 1,
          image: 'redis:8.4',
          status: 'active',
          created_at: '2025-01-01T00:00:00Z',
          manifest: '{"image":"redis:8.4","ports":["6379/tcp"]}',
        }],
      } satisfies LeaseReleasesResponse);
      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('no connection'));

      const leaseMap = new Map([['good-manifest-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['good-manifest-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'good-manifest-uuid');
      expect(app?.manifest).toBeDefined();
      const parsed = JSON.parse(app!.manifest!);
      expect(parsed.image).toBe('redis:8.4');
    });

    it('rejects connection with invalid host', async () => {
      const lease = makeLease({ uuid: 'bad-host-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-bad-host',
        leaseUuid: 'bad-host-uuid',
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
      (validateProviderUrl as Mock).mockImplementation(() => {});
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'bad-host-uuid',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        releases: [],
      } satisfies LeaseReleasesResponse);
      (getLeaseConnectionInfo as Mock).mockResolvedValue({
        lease_uuid: 'bad-host-uuid',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        connection: {
          host: 'javascript:alert(1)',
          ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 30080 } },
        },
      } satisfies LeaseConnectionResponse);
      // Fallback also returns invalid host to verify both paths validate
      (getLeaseInfo as Mock).mockResolvedValue({
        host: 'javascript:alert(1)',
        ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 30080 } },
      });

      const leaseMap = new Map([['bad-host-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['bad-host-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'bad-host-uuid');
      // Connection should NOT be stored (invalid host in both paths)
      expect(app?.connection).toBeUndefined();
    });

    it('rejects fallback connection with invalid host', async () => {
      const lease = makeLease({ uuid: 'bad-fallback-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-bad-fall',
        leaseUuid: 'bad-fallback-uuid',
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
      (validateProviderUrl as Mock).mockImplementation(() => {});
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'bad-fallback-uuid',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        releases: [],
      } satisfies LeaseReleasesResponse);
      // Primary connection fails → triggers fallback
      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('no connection'));
      // Fallback returns invalid host
      (getLeaseInfo as Mock).mockResolvedValue({
        host: '<script>alert(1)</script>',
        ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 30080 } },
      });

      const leaseMap = new Map([['bad-fallback-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['bad-fallback-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'bad-fallback-uuid');
      // Connection should NOT be stored (invalid host in fallback)
      expect(app?.connection).toBeUndefined();
    });

    it('normalizes scheme-prefixed host from getLeaseConnectionInfo', async () => {
      const lease = makeLease({ uuid: 'scheme-host-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-scheme-h',
        leaseUuid: 'scheme-host-uuid',
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
      (validateProviderUrl as Mock).mockImplementation(() => {});
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'scheme-host-uuid',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        releases: [],
      } satisfies LeaseReleasesResponse);
      (getLeaseConnectionInfo as Mock).mockResolvedValue({
        lease_uuid: 'scheme-host-uuid',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        connection: {
          host: 'https://app.example.com',
          ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 30080 } },
        },
      } satisfies LeaseConnectionResponse);

      const leaseMap = new Map([['scheme-host-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['scheme-host-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'scheme-host-uuid');
      // Host should be stored without scheme prefix
      expect(app?.connection?.host).toBe('app.example.com');
    });

    it('normalizes scheme-prefixed host from getLeaseInfo fallback', async () => {
      const lease = makeLease({ uuid: 'scheme-fb-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-scheme-f',
        leaseUuid: 'scheme-fb-uuid',
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
      (validateProviderUrl as Mock).mockImplementation(() => {});
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'scheme-fb-uuid',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        releases: [],
      } satisfies LeaseReleasesResponse);
      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('no connection'));
      (getLeaseInfo as Mock).mockResolvedValue({
        host: 'http://10.0.0.1',
        ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 30080 } },
      });

      const leaseMap = new Map([['scheme-fb-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['scheme-fb-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'scheme-fb-uuid');
      // Host should be stored without scheme prefix
      expect(app?.connection?.host).toBe('10.0.0.1');
    });

    it('normalizes host with port from getLeaseConnectionInfo (scheme + port)', async () => {
      const lease = makeLease({ uuid: 'port-host-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-port-hos',
        leaseUuid: 'port-host-uuid',
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
      (validateProviderUrl as Mock).mockImplementation(() => {});
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'port-host-uuid',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        releases: [],
      } satisfies LeaseReleasesResponse);
      (getLeaseConnectionInfo as Mock).mockResolvedValue({
        lease_uuid: 'port-host-uuid',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        connection: {
          host: 'https://app.example.com:8443',
          ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 30080 } },
        },
      } satisfies LeaseConnectionResponse);

      const leaseMap = new Map([['port-host-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['port-host-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'port-host-uuid');
      // Host should be bare hostname — port stripped (lives in connection.ports)
      expect(app?.connection?.host).toBe('app.example.com');
    });

    it('normalizes bare host with port from getLeaseInfo fallback', async () => {
      const lease = makeLease({ uuid: 'bare-port-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-bare-por',
        leaseUuid: 'bare-port-uuid',
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
      (validateProviderUrl as Mock).mockImplementation(() => {});
      (getSKU as Mock).mockResolvedValue(null);
      (getLeaseReleases as Mock).mockResolvedValue({
        lease_uuid: 'bare-port-uuid',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        releases: [],
      } satisfies LeaseReleasesResponse);
      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('no connection'));
      (getLeaseInfo as Mock).mockResolvedValue({
        host: '10.0.0.1:8080',
        ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 30080 } },
      });

      const leaseMap = new Map([['bare-port-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['bare-port-uuid'], leaseMap, mockSignArbitrary);

      const app = getAppByLease(ADDR, 'bare-port-uuid');
      // Host should be bare IP — port stripped
      expect(app?.connection?.host).toBe('10.0.0.1');
    });

    it('keeps size as unknown when SKU name sanitizes to empty string', async () => {
      const lease = makeLease({ uuid: 'empty-sku-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-empty-sk',
        leaseUuid: 'empty-sku-uuid',
        providerUrl: '',
        size: 'unknown',
      }));

      (getProvider as Mock).mockResolvedValue(null);
      (getSKU as Mock).mockResolvedValue({
        uuid: 'sku-uuid-1',
        name: '!!!',
        providerUuid: 'prov-uuid-1',
        active: true,
        basePrice: { denom: 'upwr', amount: '100' },
        unit: 0,
      });

      const leaseMap = new Map([['empty-sku-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['empty-sku-uuid'], leaseMap);

      const app = getAppByLease(ADDR, 'empty-sku-uuid');
      // Size should remain 'unknown' — not overwritten with empty string
      expect(app?.size).toBe('unknown');
    });

    it('short-circuits fallback when both Fred calls fail with auth error', async () => {
      const { ProviderApiError } = await import('../api/provider-api');
      const { logError } = await import('../utils/errors');
      const lease = makeLease({ uuid: 'auth-fail-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-auth-fai',
        leaseUuid: 'auth-fail-uuid',
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
      (validateProviderUrl as Mock).mockImplementation(() => {});
      (getSKU as Mock).mockResolvedValue(null);

      // Releases fail with 403 auth error
      (getLeaseReleases as Mock).mockRejectedValue(
        new ProviderApiError(403, 'Forbidden')
      );
      (getLeaseConnectionInfo as Mock).mockRejectedValue(
        new ProviderApiError(403, 'Forbidden')
      );

      const leaseMap = new Map([['auth-fail-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['auth-fail-uuid'], leaseMap, mockSignArbitrary);

      // Should NOT call getLeaseInfo fallback — auth errors short-circuit
      expect(getLeaseInfo).not.toHaveBeenCalled();
      // Should log the auth failure with distinct tag
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('authRejected'),
        expect.any(ProviderApiError),
      );
    });

    it('uses connection data when only releases fail with auth error', async () => {
      const { ProviderApiError } = await import('../api/provider-api');
      const lease = makeLease({ uuid: 'partial-auth-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-partial-',
        leaseUuid: 'partial-auth-uuid',
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
      (validateProviderUrl as Mock).mockImplementation(() => {});
      (getSKU as Mock).mockResolvedValue(null);

      // Releases fail with auth, but connection succeeds
      (getLeaseReleases as Mock).mockRejectedValue(
        new ProviderApiError(403, 'Forbidden')
      );
      (getLeaseConnectionInfo as Mock).mockResolvedValue({
        lease_uuid: 'partial-auth-uuid',
        tenant: ADDR,
        provider_uuid: 'prov-uuid-1',
        connection: {
          host: '10.0.0.1',
          ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 30080 } },
        },
      } satisfies LeaseConnectionResponse);

      const leaseMap = new Map([['partial-auth-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['partial-auth-uuid'], leaseMap, mockSignArbitrary);

      // Should NOT short-circuit — connection succeeded
      const app = getAppByLease(ADDR, 'partial-auth-uuid');
      expect(app?.connection?.host).toBe('10.0.0.1');
      // Fallback should not be needed since primary connection succeeded
      expect(getLeaseInfo).not.toHaveBeenCalled();
    });

    it('does NOT short-circuit fallback for non-auth errors', async () => {
      const lease = makeLease({ uuid: 'non-auth-uuid' });
      addApp(ADDR, makeApp({
        name: 'lease-non-auth',
        leaseUuid: 'non-auth-uuid',
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
      (validateProviderUrl as Mock).mockImplementation(() => {});
      (getSKU as Mock).mockResolvedValue(null);

      // Both fail with generic errors (not auth)
      (getLeaseReleases as Mock).mockRejectedValue(new Error('timeout'));
      (getLeaseConnectionInfo as Mock).mockRejectedValue(new Error('timeout'));
      // Fallback succeeds
      (getLeaseInfo as Mock).mockResolvedValue({
        host: '10.0.0.1',
        ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 30080 } },
      });

      const leaseMap = new Map([['non-auth-uuid', lease]]);
      await enrichDiscoveredLeases(ADDR, ['non-auth-uuid'], leaseMap, mockSignArbitrary);

      // Should still call getLeaseInfo fallback for non-auth errors
      expect(getLeaseInfo).toHaveBeenCalledTimes(1);
      const app = getAppByLease(ADDR, 'non-auth-uuid');
      expect(app?.connection?.host).toBe('10.0.0.1');
    });
  });

  // --- discoverUnknownLeases edge cases ---

  describe('discoverUnknownLeases edge cases', () => {
    it('returns empty array for empty lease list', () => {
      const discovered = discoverUnknownLeases(ADDR, []);
      expect(discovered).toEqual([]);
      expect(getApps(ADDR)).toHaveLength(0);
    });

    it('breaks loop on addApp failure and returns partial results', async () => {
      const { logError } = await import('../utils/errors');

      // Add the first lease normally so it succeeds
      const leases = [
        makeLease({ uuid: 'ok-uuid-1234-5678-abcdef000000' }),
        makeLease({ uuid: 'fail-uuid-234-5678-abcdef111111' }),
        makeLease({ uuid: 'skip-uuid-345-5678-abcdef222222' }),
      ];

      // After the first setItem succeeds, make subsequent setItem calls throw (simulating full localStorage)
      let setItemCallCount = 0;
      const origSetItem = localStorage.setItem.bind(localStorage);
      const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
        setItemCallCount++;
        if (setItemCallCount > 1) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        origSetItem(key, value);
      });

      const discovered = discoverUnknownLeases(ADDR, leases);

      // First lease discovered, loop breaks on second addApp failure
      expect(discovered).toEqual(['ok-uuid-1234-5678-abcdef000000']);
      expect(logError).toHaveBeenCalledWith(
        'leaseDiscovery.discoverUnknownLeases.addApp',
        expect.any(Error),
      );

      setItemSpy.mockRestore();
    });

    it('skips SKU lookup when lease has no items', () => {
      const leases = [makeLease({
        uuid: 'no-items-uuid-5678-abcdef444444',
        items: [],
      })];

      discoverUnknownLeases(ADDR, leases);

      const apps = getApps(ADDR);
      expect(apps).toHaveLength(1);
      expect(apps[0].size).toBe('unknown');
    });

    it('uses Date.now() when lease has no createdAt', () => {
      const before = Date.now();
      const leases = [makeLease({
        uuid: 'no-date-uuid-1-5678-abcdef555555',
        createdAt: undefined as unknown as Date,
      })];

      discoverUnknownLeases(ADDR, leases);

      const apps = getApps(ADDR);
      expect(apps[0].createdAt).toBeGreaterThanOrEqual(before);
      expect(apps[0].createdAt).toBeLessThanOrEqual(Date.now());
    });

    it('maps UNSPECIFIED lease state to stopped', () => {
      const leases = [makeLease({
        uuid: 'unspec-uuid-12-5678-abcdef333333',
        state: LeaseState.LEASE_STATE_UNSPECIFIED,
      })];

      discoverUnknownLeases(ADDR, leases);

      const apps = getApps(ADDR);
      expect(apps[0].status).toBe('stopped');
    });
  });
});
