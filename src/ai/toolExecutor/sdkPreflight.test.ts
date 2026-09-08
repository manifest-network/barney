import { describe, expect, it, vi } from 'vitest';
import { asAddress, asLeaseUuid, asProviderUuid, asSkuUuid, ManifestMCPErrorCode, noopLogger } from '@manifest-network/manifest-sdk';
import { deployManifest, updateApp, validateManifest, type FredAuthCtx } from '@manifest-network/manifest-sdk/deploy';
import { buildStackManifest } from '../manifest';
import { parseAndValidateStackServices } from './deployArgs';

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

describe.each([true, false])('stack defaults with applyEnvDefaults=%s', (applyEnvDefaults) => {
  it.each([
    ['web', 'nginx', 'mongo'],
    ['web', 'wordpress', 'mongo'],
    ['web', 'nginx', 'mysql'],
    ['adminer', 'adminer', 'mongo'],
  ])('keeps an unrelated %s=%s / db=%s stack valid without injecting dependencies', async (name, image, database) => {
    const parsed = parseAndValidateStackServices(JSON.stringify({
      [name]: { image, port: '80' },
      db: { image: database, port: database === 'mysql' ? '3306' : '27017' },
    }), applyEnvDefaults, 'test');
    if ('error' in parsed) throw new Error(parsed.error);

    const built = await buildStackManifest({ services: parsed.services });
    expect(validateManifest(JSON.parse(built.json))).toMatchObject({ valid: true, errors: [] });
    expect(parsed.services[name].depends_on).toBeUndefined();
  });

  it.each([
    ['web', 'docker.io/library/wordpress:6', 'mysql:8'],
    ['web', 'ghost:5', 'docker.io/library/mysql:8'],
    ['adminer', 'adminer:latest', 'postgresql:16'],
  ])('retains valid readiness defaults for %s=%s / db=%s', async (name, image, database) => {
    const parsed = parseAndValidateStackServices(JSON.stringify({
      [name]: { image }, db: { image: database },
    }), applyEnvDefaults, 'test');
    if ('error' in parsed) throw new Error(parsed.error);

    const built = await buildStackManifest({ services: parsed.services });
    expect(validateManifest(JSON.parse(built.json))).toMatchObject({ valid: true, errors: [] });
    expect(parsed.services[name].depends_on).toEqual({ db: { condition: 'service_healthy' } });
  });

  it('preserves an explicit user dependency for SDK validation', async () => {
    const dependsOn = { db: { condition: 'service_healthy' } };
    const parsed = parseAndValidateStackServices(JSON.stringify({
      web: { image: 'nginx', depends_on: dependsOn }, db: { image: 'mongo' },
    }), applyEnvDefaults, 'test');
    if ('error' in parsed) throw new Error(parsed.error);

    const built = await buildStackManifest({ services: parsed.services });
    const validation = validateManifest(JSON.parse(built.json));
    expect(parsed.services.web.depends_on).toEqual(dependsOn);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual([expect.stringContaining('requires the dependency to have an active health_check')]);
  });
});
