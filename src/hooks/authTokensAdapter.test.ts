import { describe, it, expect, vi } from 'vitest';
import { createProviderAuth } from '@manifest-network/manifest-mcp-fred';
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
    const { signer } = stubSigner();
    const providerAuth = createProviderAuth(signer, { chainId: 'manifest-test' });
    const adapter = createAuthTokensAdapter(providerAuth, ADDRESS);

    const direct = decode(await providerAuth.providerToken({ address: ADDRESS, leaseUuid: LEASE }));
    const viaAdapter = decode(await adapter.getAuthToken(LEASE));

    // Address-binding: the adapter fills tenant from its bound address.
    expect(viaAdapter.tenant).toBe(ADDRESS);
    expect(viaAdapter.tenant).toBe(direct.tenant);
    expect(viaAdapter.lease_uuid).toBe(LEASE);
    expect(viaAdapter.lease_uuid).toBe(direct.lease_uuid);
    expect(viaAdapter.pub_key).toBe(direct.pub_key);
    expect(viaAdapter.signature).toBe(direct.signature);
    // Same shared AuthTimestampTracker → monotonic, distinct per mint.
    // NOTE: the two mints differ ONLY in `timestamp`, and the shared tracker
    // blocks until the unix-second advances — so this test may take ~1s of real
    // wall-clock time. That is correct + non-flaky (a deliberate wait), NOT a hang.
    expect(typeof viaAdapter.timestamp).toBe('number');
    expect(viaAdapter.timestamp).not.toBe(direct.timestamp);
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
