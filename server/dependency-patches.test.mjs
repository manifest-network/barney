// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const patchCli = require.resolve('patch-package/index.js');

it('fails the configured postinstall when a required patch cannot apply outside CI', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'barney-dependency-patches-'));
  try {
    const installedPackage = join(fixture, 'node_modules/image-size');
    await mkdir(join(installedPackage, 'dist/types'), { recursive: true });
    await mkdir(join(fixture, 'patches'));
    await writeFile(join(fixture, 'package.json'), JSON.stringify({
      name: 'barney-patch-failure-fixture',
      private: true,
      dependencies: { 'image-size': '1.2.1' },
    }));
    await writeFile(join(installedPackage, 'package.json'), JSON.stringify({ name: 'image-size', version: '1.2.1' }));
    // Keep the expected version but deliberately remove the real patch context.
    // This exercises an application failure, rather than a missing-package error.
    await writeFile(join(installedPackage, 'dist/types/icns.js'), 'module.exports = {};\n');
    await writeFile(join(installedPackage, 'dist/types/utils.js'), 'module.exports = {};\n');
    await copyFile(join(root, 'patches/image-size+1.2.1.patch'), join(fixture, 'patches/image-size+1.2.1.patch'));

    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const [command, ...args] = pkg.scripts.postinstall.trim().split(/\s+/);
    expect(command).toBe('patch-package');
    const child = spawnSync(process.execPath, [patchCli, ...args], {
      cwd: fixture,
      // ci-info explicitly treats CI=false as disabling CI detection. Do not
      // inherit Vitest's NODE_ENV=test, which would mask a missing failure flag.
      env: { PATH: process.env.PATH, NODE_ENV: 'development', CI: 'false' },
      encoding: 'utf8',
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: 128 * 1024,
    });
    const output = child.stdout + child.stderr;
    expect(child.error, output).toBeUndefined();
    expect(child.signal, output).toBeNull();
    expect(output).toContain('Failed to apply patch for package image-size');
    expect(child.status, output).toBe(1);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 10_000);
