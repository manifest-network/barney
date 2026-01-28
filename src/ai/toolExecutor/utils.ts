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

/**
 * Extract lease UUID from a create-lease transaction result.
 * Looks for the UUID in transaction events.
 */
export function extractLeaseUuidFromTxResult(result: Record<string, unknown>): string | null {
  try {
    // Try to find the lease UUID in the transaction events
    const events = result.events as
      | Array<{
          type: string;
          attributes: Array<{ key: string; value: string }>;
        }>
      | undefined;

    if (events) {
      for (const event of events) {
        if (event.type === 'lease_created') {
          const uuidAttr = event.attributes.find(
            (attr) => attr.key === 'lease_uuid' || attr.key === 'uuid'
          );
          if (uuidAttr) {
            return uuidAttr.value;
          }
        }
      }
    }

    // Also check the response data directly
    const data = result.data as Record<string, unknown> | undefined;
    if (data && typeof data.lease_uuid === 'string') {
      return data.lease_uuid;
    }

    // Check parsed logs
    const logs = result.logs as
      | Array<{
          events: Array<{
            type: string;
            attributes: Array<{ key: string; value: string }>;
          }>;
        }>
      | undefined;

    if (logs) {
      for (const log of logs) {
        for (const event of log.events || []) {
          if (event.type === 'lease_created') {
            const uuidAttr = event.attributes.find(
              (attr) => attr.key === 'lease_uuid' || attr.key === 'uuid'
            );
            if (uuidAttr) {
              return uuidAttr.value;
            }
          }
        }
      }
    }

    return null;
  } catch {
    return null;
  }
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
