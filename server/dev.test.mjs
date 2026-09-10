// @vitest-environment node
import { loadConfig } from '@rsbuild/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  createRelay: vi.fn(),
  loadRelayConfig: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(),
  spawn: mocks.spawn,
}));
vi.mock('./relay.mjs', () => ({ createRelay: mocks.createRelay }));
vi.mock('./config.mjs', () => ({
  loadRelayConfig: mocks.loadRelayConfig,
  RelayConfigError: class RelayConfigError extends Error {},
}));

describe('development wrapper arguments', () => {
  let originalArgv;
  let processOnce;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalArgv = process.argv;
    processOnce = vi.spyOn(process, 'once');
    mocks.loadRelayConfig.mockReturnValue({});
    mocks.createRelay.mockResolvedValue({
      listen: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });
    mocks.spawn.mockReturnValue({
      exitCode: null,
      kill: vi.fn(),
      once: vi.fn().mockReturnThis(),
    });
  });

  afterEach(() => {
    for (const [event, listener] of processOnce.mock.calls) {
      if (event === 'SIGTERM' || event === 'SIGINT') process.removeListener(event, listener);
    }
    process.argv = originalArgv;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('forwards host and port flags while preserving the host fallback and removing relay secrets', async () => {
    const args = ['--host', '0.0.0.0', '--port', '4321'];
    process.argv = [process.execPath, 'server/dev.mjs', ...args];
    vi.stubEnv('BARNEY_DEV_HOST', '127.0.0.1');
    vi.stubEnv('MORPHEUS_API_KEY', 'test-provider-secret');
    vi.stubEnv('MORPHEUS_RELAY_IDENTITY_HMAC_KEY', 'test-identity-secret');

    await import('./dev.mjs');
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());

    const [executable, forwardedArgs, options] = mocks.spawn.mock.calls[0];
    expect(executable).toBe(process.execPath);
    expect(forwardedArgs).toEqual(['node_modules/@rsbuild/core/bin/rsbuild.js', 'dev', ...args]);
    expect(options.env.BARNEY_DEV_HOST).toBe('127.0.0.1');
    expect(options.env).not.toHaveProperty('MORPHEUS_API_KEY');
    expect(options.env).not.toHaveProperty('MORPHEUS_RELAY_IDENTITY_HMAC_KEY');
  });

  it('retains the loopback default when no host option or environment override is supplied', async () => {
    process.argv = [process.execPath, 'server/dev.mjs'];
    vi.stubEnv('BARNEY_DEV_HOST', undefined);

    await import('./dev.mjs');
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());

    const [, forwardedArgs, options] = mocks.spawn.mock.calls[0];
    expect(forwardedArgs).toEqual(['node_modules/@rsbuild/core/bin/rsbuild.js', 'dev']);
    expect(options.env).not.toHaveProperty('BARNEY_DEV_HOST');
    const { content: config } = await loadConfig();
    expect(config.server.host).toBe('127.0.0.1');
  });
});
