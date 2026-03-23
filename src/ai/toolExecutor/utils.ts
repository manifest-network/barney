/**
 * Utility functions for tool execution
 */

import { sha256Hex as computePayloadHash, isValidMetaHash } from '../../utils/hash';
import {
  createLeaseDataSignMessage,
  createSignMessage,
  createAuthToken,
  uploadLeaseData,
  ProviderApiError,
} from '../../api/provider-api';
import type { ToolResult, SignResult } from './types';

// Re-export for backward compatibility
export { extractLeaseUuid as extractLeaseUuidFromTxResult } from '../../utils/tx';

/**
 * Create a provider auth token for ADR-036 authenticated requests.
 * Centralizes the sign-and-create-token pattern used across query and TX executors.
 */
export async function getProviderAuthToken(
  address: string,
  leaseUuid: string,
  signArbitrary: (address: string, data: string) => Promise<SignResult>
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = createSignMessage(address, leaseUuid, timestamp);
  const signResult = await signArbitrary(address, message);
  return createAuthToken(address, leaseUuid, timestamp, signResult.pub_key.value, signResult.signature);
}

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
    let signResult: SignResult;
    try {
      signResult = await signArbitrary(address, signMessage);
    } catch (signError) {
      return {
        success: false,
        error: `Failed to sign message: ${signError instanceof Error ? signError.message : 'Signing rejected or failed'}`,
      };
    }

    // Validate sign result has required fields
    if (!signResult?.pub_key?.value || !signResult?.signature) {
      return {
        success: false,
        error: 'Invalid signature result: missing public key or signature. Please try again.',
      };
    }

    // Create the auth token
    const authToken = createAuthToken(
      address,
      leaseUuid,
      timestamp,
      signResult.pub_key.value,
      signResult.signature,
      metaHashHex
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
