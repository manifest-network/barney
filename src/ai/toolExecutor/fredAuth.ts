/**
 * Shared ADR-036 auth-token closures + query-client helper for the mono fred
 * capability functions (deployManifest / restartApp / updateApp / getAppLogs).
 *
 * fred's functions take a `getAuthToken: (address, leaseUuid) => Promise<string>`
 * (and deploy additionally a `getLeaseDataAuthToken` that binds the manifest
 * meta-hash). Barney mints both from `signArbitrary` via the existing ADR-036
 * builders — this module centralizes that wiring so every fred call site shares
 * one implementation.
 */

import type { CosmosClientManager, ManifestQueryClient } from '@manifest-network/manifest-mcp-core';
import { createLeaseDataSignMessage, createAuthToken } from '../../api/provider-api';
import { getProviderAuthToken } from './utils';
import type { SignArbitraryFn } from './types';

export interface FredAuthTokens {
  /** Lease-scoped token (status / logs / restart / connection). */
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>;
  /** Upload token binding the manifest meta-hash (payload upload during deploy/update). */
  getLeaseDataAuthToken: (address: string, leaseUuid: string, metaHashHex: string) => Promise<string>;
}

/** Build the two ADR-036 token closures fred's deploy/restart/update/logs functions expect. */
export function makeFredAuthTokens(signArbitrary: SignArbitraryFn): FredAuthTokens {
  return {
    getAuthToken: (address, leaseUuid) => getProviderAuthToken(address, leaseUuid, signArbitrary),
    getLeaseDataAuthToken: async (address, leaseUuid, metaHashHex) => {
      const timestamp = Math.floor(Date.now() / 1000);
      const message = createLeaseDataSignMessage(leaseUuid, metaHashHex, timestamp);
      const sig = await signArbitrary(address, message);
      return createAuthToken(address, leaseUuid, timestamp, sig.pub_key.value, sig.signature, metaHashHex);
    },
  };
}

/** Resolve the ManifestQueryClient that fred's restart/update/logs functions require. */
export function getFredQueryClient(clientManager: CosmosClientManager): Promise<ManifestQueryClient> {
  return clientManager.getQueryClient();
}
