/**
 * ADR-036 auth-token adapter (ENG-279 C1 / spec §3.4).
 *
 * Binds an address-PARAM `ProviderAuthPort` into barney's address-BOUND
 * `AuthTokens` shape. ONE `createProviderAuth` instance backs both the
 * FredAuthCtx (address-param, C2) and this adapter (address-bound) — never a
 * second `createProviderAuth`, which would re-open the same-lease/same-second
 * ADR-036 replay collision D2 exists to prevent.
 */
import type { ProviderAuthPort } from '@manifest-network/manifest-sdk/deploy';
import type { AuthTokens } from '../ai/toolExecutor/types';

export function createAuthTokensAdapter(
  providerAuth: ProviderAuthPort,
  address: string,
): AuthTokens {
  return {
    getAuthToken: (leaseUuid) => providerAuth.providerToken({ address, leaseUuid }),
    getLeaseDataAuthToken: (leaseUuid, metaHashHex) =>
      providerAuth.leaseDataToken({ address, leaseUuid, metaHashHex }),
  };
}
