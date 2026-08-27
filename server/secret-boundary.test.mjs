// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('provider-key configuration boundary', () => {
  it('keeps the provider-key variable out of every browser/nginx template and dev proxy', async () => {
    const [nginx, browserConfig, rsbuild] = await Promise.all([
      source('docker/nginx.conf.template'),
      source('docker/config.js.template'),
      source('rsbuild.config.ts'),
    ]);

    for (const artifact of [nginx, browserConfig, rsbuild]) {
      expect(artifact).not.toContain('MORPHEUS_API_KEY');
      expect(artifact).not.toContain('Authorization: Bearer');
    }
  });

  it('renders nginx with an explicit non-secret envsubst allowlist', async () => {
    const entrypoint = await source('docker/env.sh');
    expect(entrypoint).toContain("envsubst '$BARNEY_TRUSTED_PROXY_CIDR $MORPHEUS_RELAY_PORT'");
    expect(entrypoint).not.toMatch(/envsubst[^\n]*(MORPHEUS_API_KEY|PUBLIC_MORPHEUS_URL)/);
  });

  it('removes relay secrets before spawning nginx', async () => {
    const supervisor = await source('server/main.mjs');
    expect(supervisor).toContain('delete nginxEnv.MORPHEUS_API_KEY');
    expect(supervisor).toContain('delete nginxEnv.MORPHEUS_RELAY_IDENTITY_HMAC_KEY');
    expect(supervisor).toContain('env: nginxEnv');
  });
});
