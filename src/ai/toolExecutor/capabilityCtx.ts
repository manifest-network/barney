import type { EventTransport } from '@manifest-network/manifest-sdk';
import { noopLogger, type CosmosClientManager } from '@manifest-network/manifest-sdk';
import type { FredAuthCtx } from '@manifest-network/manifest-sdk/deploy';
import { getReadClient } from '../../api/readClient';
import { providerFetch } from '../../api/providerFetchAdapter';
import type { SigningContext } from './types';

/**
 * The one capability ctx barney threads into every SDK provider op.
 *
 * A single value satisfies each op's ctx param because they are Pick-subsets:
 *  - `FredAuthCtx` (deployManifest, appStatus, restartApp, updateApp) — query+chain+
 *    fetch+logger+allowLoopback?+providerAuth;
 *  - `WaitForLeaseStatusCtx` (waitForLeaseStatus) — adds the optional `events` WS transport.
 *
 * `signer` is deliberately omitted — it stays encapsulated inside `providerAuth`
 * (the single ADR-036 minter built at the useManifestMCP root); no in-scope op reads
 * `ctx.signer`. `chain` MUST be the SIGNING CosmosClientManager (broadcast +
 * withBroadcastLock); `query` is the read-only client's LCD-adapter query.
 * `allowLoopback` carries barney's DEV switch down to the SDK's provider-URL guard
 * so dev-localhost provider calls are permitted (ENG-490); the dev CORS proxy still
 * routes the actual request.
 */
export type BarneyCtx = FredAuthCtx & { events?: EventTransport };

export async function buildBarneyCtx(
  clientManager: CosmosClientManager,
  signing: SigningContext,
  opts?: { events?: EventTransport },
): Promise<BarneyCtx> {
  const readClient = await getReadClient();
  return {
    query: readClient.query,
    chain: clientManager,
    fetch: providerFetch,
    logger: noopLogger,
    allowLoopback: import.meta.env.DEV,
    providerAuth: signing.providerAuth,
    events: opts?.events,
  };
}
