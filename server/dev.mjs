import { spawn } from 'node:child_process';
import { createRelay } from './relay.mjs';
import { RelayConfigError, loadRelayConfig } from './config.mjs';

async function main() {
  const config = loadRelayConfig();
  const relay = await createRelay({ config });
  await relay.listen();

  const rsbuildEnv = { ...process.env };
  delete rsbuildEnv.MORPHEUS_API_KEY;
  delete rsbuildEnv.MORPHEUS_RELAY_IDENTITY_HMAC_KEY;
  const rsbuild = spawn(
    process.execPath,
    ['node_modules/@rsbuild/core/bin/rsbuild.js', 'dev'],
    { stdio: 'inherit', env: rsbuildEnv },
  );
  let shuttingDown = false;

  const shutdown = async (signal, exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (rsbuild.exitCode === null) rsbuild.kill(signal);
    await relay.close().catch(() => {});
    process.exitCode = exitCode;
  };

  process.once('SIGTERM', () => { void shutdown('SIGTERM', 0); });
  process.once('SIGINT', () => { void shutdown('SIGINT', 130); });
  rsbuild.once('error', () => { void shutdown('SIGTERM', 1); });
  rsbuild.once('exit', (code, signal) => {
    const exitCode = code ?? (signal ? 1 : 0);
    void shutdown('SIGTERM', exitCode);
  });
}

main().catch((error) => {
  const message = error instanceof RelayConfigError
    ? error.message
    : 'Morpheus relay failed to initialize';
  process.stderr.write(`ERROR: ${message}\n`);
  process.exitCode = 1;
});
