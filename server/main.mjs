import { spawn } from 'node:child_process';
import { createRelay } from './relay.mjs';
import { RelayConfigError, loadRelayConfig } from './config.mjs';

async function main() {
  // Nginx only forwards to localhost and must never inherit relay secrets.
  // Copy the environment so the Node relay retains its own credentials.
  const nginxEnv = { ...process.env };
  delete nginxEnv.MORPHEUS_API_KEY;
  delete nginxEnv.MORPHEUS_RELAY_IDENTITY_HMAC_KEY;
  const nginx = spawn('nginx', ['-g', 'daemon off;'], {
    stdio: 'inherit',
    env: nginxEnv,
  });
  let relay;
  let shuttingDown = false;

  const shutdown = async (signal, exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (nginx.exitCode === null) nginx.kill(signal);
    await relay?.close().catch(() => {});
    process.exitCode = exitCode;
  };

  process.once('SIGTERM', () => { void shutdown('SIGTERM', 0); });
  process.once('SIGINT', () => { void shutdown('SIGINT', 130); });
  nginx.once('error', () => { void shutdown('SIGTERM', 1); });
  nginx.once('exit', (code, signal) => {
    const exitCode = code ?? (signal ? 1 : 0);
    void shutdown('SIGTERM', exitCode);
  });

  // The SPA remains available when paid inference is misconfigured or its
  // durable ledger is corrupt. Nginx returns 502/503 for the relay namespace,
  // while its readiness probe and the container health check fail closed.
  try {
    const config = loadRelayConfig();
    const candidate = await createRelay({ config });
    await candidate.listen();
    if (shuttingDown) await candidate.close();
    else relay = candidate;
  } catch (error) {
    const message = error instanceof RelayConfigError
      ? error.message
      : 'Morpheus relay failed to initialize';
    process.stderr.write(`ERROR: ${message}\n`);
  }
}

main().catch(() => {
  process.stderr.write('ERROR: Barney supervisor failed to initialize\n');
  process.exitCode = 1;
});
