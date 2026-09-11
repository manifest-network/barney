// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRsbuild, loadConfig } from '@rsbuild/core';
import { describe, expect, it, vi } from 'vitest';

describe('local asset server network boundary', () => {
  const cases = ['dev', 'preview'].flatMap((mode) => [
    { mode, setting: 'unset', host: undefined, address: '127.0.0.1' },
    { mode, setting: 'blank', host: '  ', address: '127.0.0.1' },
    { mode, setting: 'explicit override', host: ' 0.0.0.0 ', address: '0.0.0.0' },
  ]);

  it.each(cases)('$mode binds to $address with $setting BARNEY_DEV_HOST', async ({ mode, host, address: expectedAddress }) => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'barney-loopback-'));
    const listen = vi.spyOn(Server.prototype, 'listen');
    let closeServer;
    try {
      vi.stubEnv('BARNEY_DEV_HOST', host);
      await writeFile(join(fixtureDir, 'index.html'), '<p>Loopback fixture</p>');
      const { content: config } = await loadConfig();
      const rsbuild = await createRsbuild({
        loadEnv: false,
        rsbuildConfig: {
          ...config,
          dev: { ...config.dev, cliShortcuts: false },
          output: { ...config.output, distPath: { root: fixtureDir } },
          server: {
            ...config.server,
            port: 0,
            printUrls: false,
            publicDir: { name: fixtureDir, copyOnBuild: false },
          },
        },
      });
      if (mode === 'dev') {
        const server = await rsbuild.createDevServer({ runCompile: false });
        closeServer = () => server.close();
        await server.listen();
      } else {
        const { server } = await rsbuild.preview();
        closeServer = () => server.close();
      }

      // Observe the real bound socket, including preview's internal HTTP server.
      expect(listen).toHaveBeenCalledTimes(1);
      const address = listen.mock.contexts[0].address();
      expect(address.address).toBe(expectedAddress);
      const response = await fetch(`http://127.0.0.1:${address.port}/index.html`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<p>Loopback fixture</p>');
    } finally {
      try {
        await closeServer?.();
      } finally {
        listen.mockRestore();
        vi.unstubAllEnvs();
        await rm(fixtureDir, { recursive: true, force: true });
      }
    }
  });
});
