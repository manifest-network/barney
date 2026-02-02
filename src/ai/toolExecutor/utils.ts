/**
 * Utility functions for tool execution
 */

import {
  computePayloadHash,
  isValidMetaHash,
  createLeaseDataSignMessage,
  createLeaseDataAuthToken,
  uploadLeaseData,
} from '../../api/provider-api';
import type { ToolResult, SignResult } from './types';

// Re-export for backward compatibility
export { extractLeaseUuid as extractLeaseUuidFromTxResult } from '../../utils/tx';

/**
 * Upload payload to provider with ADR-036 authentication.
 */
export async function uploadPayloadToProvider(
  providerApiUrl: string,
  leaseUuid: string,
  metaHashHex: string,
  payload: Uint8Array,
  address: string,
  signArbitrary: (address: string, data: string) => Promise<SignResult>
): Promise<ToolResult> {
  try {
    // Validate meta_hash format
    if (!isValidMetaHash(metaHashHex)) {
      return {
        success: false,
        error: `Invalid meta_hash format: ${metaHashHex}. Must be 64 hex characters.`,
      };
    }

    // Create the sign message
    const timestamp = Math.floor(Date.now() / 1000);
    const signMessage = createLeaseDataSignMessage(leaseUuid, metaHashHex, timestamp);

    // Sign the message using ADR-036
    const signResult = await signArbitrary(address, signMessage);

    // Create the auth token
    const authToken = createLeaseDataAuthToken(
      address,
      leaseUuid,
      metaHashHex,
      timestamp,
      signResult.pub_key.value,
      signResult.signature
    );

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
    // Handle specific error codes
    if (error instanceof Error) {
      const errorMsg = error.message.toLowerCase();

      if (errorMsg.includes('409') || errorMsg.includes('conflict')) {
        return {
          success: true,
          data: {
            message: 'Payload already uploaded (idempotent success)',
            leaseUuid,
            metaHash: metaHashHex,
          },
        };
      }

      if (errorMsg.includes('401') || errorMsg.includes('unauthorized')) {
        return {
          success: false,
          error: 'Authentication failed. The signature may have expired. Please try again.',
        };
      }

      if (errorMsg.includes('404') || errorMsg.includes('not found')) {
        return {
          success: false,
          error: 'Lease not found or not in PENDING state. Payload upload is only allowed for pending leases.',
        };
      }

      if (errorMsg.includes('400') || errorMsg.includes('bad request')) {
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
