import { createManifestReadClient } from '@manifest-network/manifest-sdk';
import { REST_URL } from './config';
import { CHAIN_ID } from '../config/chain';

type ManifestReadClient = Awaited<ReturnType<typeof createManifestReadClient>>;

let clientPromise: Promise<ManifestReadClient> | null = null;

/**
 * One cached query-only read client for the app session. Mirrors `getQueryClient`
 * in queryClient.ts: a module-level cached promise, reset to null on failure so a
 * transient boot error can be retried.
 *
 * Config is `{ chainId, restUrl }` — NO rpcUrl. createManifestReadClient runs
 * createValidatedConfig internally (chainId + https-or-localhost restUrl required;
 * gasPrice only required with rpcUrl). Omitting rpcUrl keys the underlying
 * CosmosClientManager (chainId:rpcUrl:restUrl) differently from the signing client,
 * so disposing this client never tears down the wallet's signing client, and it
 * keeps the LCD transport (numeric enum preservation via the LCD-adapter fromJSON
 * path) — the reason fixSKUEnums is deletable.
 *
 * NOTE: the chainId passed here is CHAIN_ID (sourced from the PUBLIC_CHAIN_ID env
 * via runtimeConfig; defaults to 'manifest-ledger-beta', so it is non-empty in
 * practice). An empty chainId would throw INVALID_CONFIG. PROD restUrl must be https.
 */
export function getReadClient(): Promise<ManifestReadClient> {
  if (!clientPromise) {
    clientPromise = createManifestReadClient({
      config: { chainId: CHAIN_ID, restUrl: REST_URL },
    }).catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
}

/**
 * Release the cached read client's share of the underlying keyed
 * CosmosClientManager (balances the one getInstance the factory acquired).
 * Idempotent. Called from AIProvider unmount. A wallet change needs no dispose:
 * the read client carries no wallet identity (address is a per-call arg) and its
 * config key excludes rpcUrl, so it never collides with the signing client.
 */
export async function disposeReadClient(): Promise<void> {
  const pending = clientPromise;
  clientPromise = null;
  if (!pending) return;
  try {
    (await pending).dispose();
  } catch {
    // best-effort teardown; a client that never resolved has nothing to dispose
  }
}
