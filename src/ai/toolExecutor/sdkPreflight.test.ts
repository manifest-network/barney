import { describe, expect, it, vi } from 'vitest';
import { asAddress, asLeaseUuid, asProviderUuid, asSkuUuid, ManifestMCPErrorCode, noopLogger } from '@manifest-network/manifest-sdk';
import { deployManifest, updateApp, type FredAuthCtx } from '@manifest-network/manifest-sdk/deploy';

const LEASE_UUID = asLeaseUuid('550e8400-e29b-41d4-a716-446655440000');

function preflightContext() {
  const access = vi.fn(() => { throw new Error('Preflight must reject before accessing a wallet or provider'); });
  const ctx = {
    chain: { getAddress: access, acquireRateLimit: access },
    query: {},
    providerAuth: { providerToken: access, leaseDataToken: access },
    fetch: access,
    logger: noopLogger,
  } as unknown as FredAuthCtx;
  return { ctx, access };
}

describe('SDK preflight at Barney transaction boundaries', () => {
  it('rejects a malformed domain before creating a paid lease', async () => {
    const { ctx, access } = preflightContext();
    await expect(deployManifest(ctx, {
      manifest: '{"image":"nginx","ports":{"80/tcp":{}}}',
      sku: { kind: 'resolved', skuUuid: asSkuUuid('sku-1'), providerUuid: asProviderUuid('p1') },
      customDomain: 'not a domain!',
    })).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_ARGUMENT });
    expect(access).not.toHaveBeenCalled();
  });

  it.each([
    ['duplicate JSON keys', '{"image":"nginx","image":"redis"}'],
    ['non-integer literal spelling', '{"image":"nginx","health_check":{"test":["CMD","true"],"retries":1.0}}'],
    ['mixed stack and single-service fields', '{"services":{"web":{"image":"nginx"}},"image":"redis"}'],
  ])('rejects %s before authenticating or posting an update', async (_label, manifest) => {
    const { ctx, access } = preflightContext();
    await expect(updateApp(ctx, {
      address: asAddress('manifest1tenant'),
      leaseUuid: LEASE_UUID,
      manifest,
    }, { providerUrl: 'https://provider.example.com', pollOptions: false }))
      .rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    expect(access).not.toHaveBeenCalled();
  });
});
