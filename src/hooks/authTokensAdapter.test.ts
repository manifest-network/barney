import { describe, it, expect, vi } from 'vitest';
import { createProviderAuth } from '@manifest-network/manifest-sdk/deploy';
import { asLeaseUuid } from '@manifest-network/manifest-sdk';
import type { Signer } from '@manifest-network/manifest-mcp-core';
import { createAuthTokensAdapter } from './authTokensAdapter';

const ADDRESS = 'manifest1test000000000000000000000000000000';
const LEASE = asLeaseUuid('550e8400-e29b-41d4-a716-446655440000');
const META_HASH = 'a'.repeat(64);

// Deterministic stub signer: fixed pub_key/signature so the ONLY field that can
// differ between two mints is the tracker-advanced `timestamp`.
function stubSigner() {
  const signArbitrary = vi.fn(async () => ({
    pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'PUBKEYVALUE' },
    signature: 'SIGVALUE',
  }));
  const signer = {
    getAddress: async () => ADDRESS,
    signArbitrary,
  } as unknown as Signer;
  return { signer, signArbitrary };
}

// The provider token is base64(JSON(payload)); JSON is ASCII, so atob round-trips.
function decode(token: string) {
  return JSON.parse(atob(token)) as {
    tenant: string;
    lease_uuid: string;
    timestamp: number;
    pub_key: string;
    signature: string;
    meta_hash?: string;
  };
}

describe('createAuthTokensAdapter', () => {
  it('produces ADR-036 provider tokens identical (minus timestamp) to the underlying port', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    try {
      const { signer } = stubSigner();
      const providerAuth = createProviderAuth(signer, { chainId: 'manifest-test' });
      const adapter = createAuthTokensAdapter(providerAuth, ADDRESS);

      // Mint 1: first mint in this unix-second, AuthTimestampTracker's `last`
      // starts at 0 so it resolves on microtasks alone — no timer to advance.
      const direct = decode(await providerAuth.providerToken({ address: ADDRESS, leaseUuid: LEASE }));

      // Mint 2: same unix-second as mint 1, so the shared tracker blocks inside
      // `await new Promise(resolve => setTimeout(resolve, sleepMs))` until the
      // second advances. Start it WITHOUT awaiting, then drive the fake clock
      // forward — awaiting first would hang forever since fake timers never
      // fire on their own.
      const viaAdapterPromise = adapter.getAuthToken(LEASE);
      await vi.advanceTimersByTimeAsync(1000);
      const viaAdapter = decode(await viaAdapterPromise);

      // Address-binding: the adapter fills tenant from its bound address.
      expect(viaAdapter.tenant).toBe(ADDRESS);
      expect(viaAdapter.tenant).toBe(direct.tenant);
      expect(viaAdapter.lease_uuid).toBe(LEASE);
      expect(viaAdapter.lease_uuid).toBe(direct.lease_uuid);
      expect(viaAdapter.pub_key).toBe(direct.pub_key);
      expect(viaAdapter.signature).toBe(direct.signature);
      // Same shared AuthTimestampTracker → monotonic, distinct per mint.
      // NOTE: the tracker's inter-mint wait is faked away via
      // `vi.advanceTimersByTimeAsync`, so this no longer costs ~1s of real
      // wall-clock time. The timestamp-differs check below is a light
      // sanity check on the fake clock; the real delegation guarantee (that
      // the adapter calls through to the same providerAuth instance) is
      // covered by the second test below (the spy-port test).
      expect(typeof viaAdapter.timestamp).toBe('number');
      expect(viaAdapter.timestamp).not.toBe(direct.timestamp);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delegates the SAME providerAuth instance (no second createProviderAuth)', async () => {
    const spy = {
      providerToken: vi.fn().mockResolvedValue('ptoken'),
      leaseDataToken: vi.fn().mockResolvedValue('ldtoken'),
    };
    const adapter = createAuthTokensAdapter(spy, ADDRESS);

    await expect(adapter.getAuthToken(LEASE)).resolves.toBe('ptoken');
    expect(spy.providerToken).toHaveBeenCalledWith({ address: ADDRESS, leaseUuid: LEASE });

    await expect(adapter.getLeaseDataAuthToken(LEASE, META_HASH)).resolves.toBe('ldtoken');
    expect(spy.leaseDataToken).toHaveBeenCalledWith({
      address: ADDRESS,
      leaseUuid: LEASE,
      metaHashHex: META_HASH,
    });
  });
});
