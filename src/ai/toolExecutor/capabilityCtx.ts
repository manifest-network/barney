import type { EventTransport } from '@manifest-network/manifest-sdk';
import { ManifestMCPError, ManifestMCPErrorCode, noopLogger, type CosmosClientManager } from '@manifest-network/manifest-sdk';
import type { FredAuthCtx } from '@manifest-network/manifest-sdk/deploy';
import { getReadClient } from '../../api/readClient';
import { providerFetch } from '../../api/providerFetchAdapter';
import { getFredCompatibility } from '../../config/fredCompatibility';
import { getProviderAllowlist, isProviderAllowed } from '../../config/providerAllowlist';
import type { SigningContext } from './types';

/**
 * QUERY_FAILED, not an infrastructure code: appStatus then keeps its chain
 * reading and reports a provider error, and deployManifest stops before
 * creating a lease.
 */
export class ProviderNotAllowedError extends ManifestMCPError {
  constructor(providerUuid: string) {
    super(ManifestMCPErrorCode.QUERY_FAILED, `Provider ${providerUuid} is not offered by this deployment.`);
    // ManifestMCPError pins its own prototype, which would defeat `instanceof` here.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ProviderNotAllowedError';
  }
}

function withProperty<T extends object>(target: T, key: PropertyKey, value: unknown): T {
  return new Proxy(target, {
    get: (object, property) => (property === key ? value : Reflect.get(object, property, object)),
  });
}

/**
 * ENG-1457: SDK ops resolve a provider's URL from chain when they run
 * (deployManifest just before create-lease, appStatus before its reads), and
 * that URL can differ from the one Barney planned with. Check the URL the SDK
 * actually received.
 */
function allowlistedQuery(query: FredAuthCtx['query']): FredAuthCtx['query'] {
  try {
    if (!getProviderAllowlist()) return query;
  } catch {
    // An invalid setting allows no provider; the guard below fails closed.
  }
  const v1 = query.liftedinit.sku.v1;
  const provider: typeof v1.provider = async (request) => {
    const response = await v1.provider(request);
    if (!isProviderAllowed(response.provider?.apiUrl)) throw new ProviderNotAllowedError(request.uuid);
    return response;
  };
  return withProperty(query, 'liftedinit', withProperty(query.liftedinit, 'sku',
    withProperty(query.liftedinit.sku, 'v1', withProperty(v1, 'provider', provider))));
}

/**
 * The one capability ctx barney threads into every SDK provider op.
 *
 * A single value satisfies each op's ctx param because they are Pick-subsets
 * (naming the SDK ops barney actually threads this ctx into):
 *  - `FredAuthCtx` (deployManifest, appStatus) — query+chain+
 *    fetch+logger+allowLoopback?+providerAuth;
 *  - `WaitForLeaseStatusCtx` (waitForLeaseStatus) — adds the optional `events` WS transport.
 *
 * `signer` is deliberately omitted — it stays encapsulated inside `providerAuth`
 * (the single ADR-036 minter built at the useManifestMCP root); no in-scope op reads
 * `ctx.signer`. `chain` MUST be the SIGNING CosmosClientManager (broadcast +
 * withBroadcastLock); `query` is the read-only client's LCD-adapter query,
 * with provider lookups checked against PUBLIC_PROVIDER_ALLOWLIST.
 * `allowLoopback` carries barney's DEV switch down to the SDK's provider-URL guard
 * so dev-localhost provider calls are permitted (ENG-490); the dev CORS proxy still
 * routes the actual request.
 */
export type BarneyCtx = FredAuthCtx & { events?: EventTransport };

export async function buildBarneyCtx(
  clientManager: CosmosClientManager,
  signing: SigningContext,
  opts?: { events?: EventTransport; operation?: 'query' | 'mutation' },
): Promise<BarneyCtx> {
  const readClient = await getReadClient();
  return {
    query: allowlistedQuery(readClient.query),
    chain: clientManager,
    fetch: providerFetch,
    logger: noopLogger,
    allowLoopback: import.meta.env.DEV,
    providerAuth: signing.providerAuth,
    // SDK reads do not consult the mutation protocol selector. A typo must
    // not prevent status/diagnostics from observing the existing deployment.
    ...(opts?.operation !== 'query' && { fredCompatibility: getFredCompatibility() }),
    events: opts?.events,
  };
}
