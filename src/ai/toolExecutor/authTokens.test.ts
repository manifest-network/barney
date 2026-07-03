import { describe, it, expect, vi } from 'vitest';
import { createSignerAdapter, asLeaseUuid, type WalletProvider } from '@manifest-network/manifest-sdk';
import { createAuthTokens } from '@manifest-network/manifest-sdk/deploy';
import type { OfflineSigner } from '@cosmjs/proto-signing';

const ADDRESS = 'manifest1qyqszqgpqyqszqgpqyqszqgpqyqszqgpn3rfe5';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const META_HASH = 'a'.repeat(64);
const SIGN_RESULT = {
  pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'pubkeybase64==' },
  signature: 'sigbase64==',
};
const CHAIN_ID = 'manifest-ledger-beta';

function stubWallet(sign = vi.fn().mockResolvedValue(SIGN_RESULT)): WalletProvider {
  return {
    getAddress: async () => ADDRESS,
    getSigner: async () => ({}) as OfflineSigner,
    signArbitrary: sign,
  };
}

describe('createAuthTokens wiring (Barney composition root)', () => {
  it('getAuthToken mints a token that decodes to the expected ADR-036 fields', async () => {
    const tokens = createAuthTokens(createSignerAdapter(stubWallet(), 'manifest'), { chainId: CHAIN_ID });
    const decoded = JSON.parse(atob(await tokens.getAuthToken(asLeaseUuid(LEASE_UUID))));
    expect(decoded.tenant).toBe(ADDRESS);
    expect(decoded.lease_uuid).toBe(LEASE_UUID);
    expect(decoded.pub_key).toBe(SIGN_RESULT.pub_key.value);
    expect(decoded.signature).toBe(SIGN_RESULT.signature);
    expect(decoded.meta_hash).toBeUndefined();
  });

  it('getLeaseDataAuthToken embeds the meta_hash', async () => {
    const tokens = createAuthTokens(createSignerAdapter(stubWallet(), 'manifest'), { chainId: CHAIN_ID });
    const decoded = JSON.parse(atob(await tokens.getLeaseDataAuthToken(asLeaseUuid(LEASE_UUID), META_HASH)));
    expect(decoded.tenant).toBe(ADDRESS);
    expect(decoded.lease_uuid).toBe(LEASE_UUID);
    expect(decoded.meta_hash).toBe(META_HASH);
  });

  it('rejects when the wallet cannot signArbitrary (mirrors Barney "wallet can\'t sign" gate)', async () => {
    const noSign: WalletProvider = { getAddress: async () => ADDRESS, getSigner: async () => ({}) as OfflineSigner };
    const tokens = createAuthTokens(createSignerAdapter(noSign, 'manifest'), { chainId: CHAIN_ID });
    await expect(tokens.getAuthToken(asLeaseUuid(LEASE_UUID))).rejects.toThrow(/signArbitrary/);
  });
});
