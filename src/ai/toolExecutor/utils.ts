/**
 * Utility functions for tool execution
 */

import { sha256Hex as computePayloadHash, isValidMetaHash } from '../../utils/hash';
import { uploadLeaseData, ProviderApiError } from '../../api/provider-api';
import type { LeaseUuid } from '@manifest-network/manifest-sdk';
import type { AuthTokens, ToolResult } from './types';

// Re-export for backward compatibility
export { extractLeaseUuid as extractLeaseUuidFromTxResult } from '../../utils/tx';

/**
 * Upload payload to provider with ADR-036 authentication.
 * The lease-data auth token is minted by the root-built `authTokens` factory
 * (address-bound, mutex-serialized). The 64-hex `meta_hash` precheck is retained
 * here — the factory does not validate hash form.
 */
export async function uploadPayloadToProvider(
  providerApiUrl: string,
  leaseUuid: LeaseUuid,
  metaHashHex: string,
  payload: Uint8Array,
  authTokens: AuthTokens
): Promise<ToolResult> {
  try {
    // Validate meta_hash format
    if (!isValidMetaHash(metaHashHex)) {
      return {
        success: false,
        error: `Invalid meta_hash format: ${metaHashHex}. Must be 64 hex characters.`,
      };
    }

    // Mint the lease-data auth token via the factory (ADR-036 signing happens here).
    let authToken: string;
    try {
      authToken = await authTokens.getLeaseDataAuthToken(leaseUuid, metaHashHex);
    } catch (signError) {
      return {
        success: false,
        error: `Failed to sign message: ${signError instanceof Error ? signError.message : 'Signing rejected or failed'}`,
      };
    }

    // Upload the payload
    await uploadLeaseData(providerApiUrl, leaseUuid, payload, authToken);

    return {
      success: true,
      data: {
        message: 'Payload uploaded successfully',
        leaseUuid,
        metaHash: metaHashHex,
      },
    };
  } catch (error) {
    // Handle specific HTTP status codes from provider API
    if (error instanceof ProviderApiError) {
      switch (error.status) {
        case 409:
          return {
            success: true,
            data: {
              message: 'Payload already uploaded (idempotent success)',
              leaseUuid,
              metaHash: metaHashHex,
            },
          };
        case 401:
          return {
            success: false,
            error: 'Authentication failed. The signature may have expired. Please try again.',
          };
        case 404:
          return {
            success: false,
            error: 'Lease not found or not in PENDING state. Payload upload is only allowed for pending leases.',
          };
        case 400:
          return {
            success: false,
            error: 'Payload hash does not match the lease meta_hash, or payload is invalid.',
          };
      }
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during payload upload',
    };
  }
}

// Re-export computePayloadHash for use in transactions
export { computePayloadHash };
