/**
 * Shared transaction utilities for extracting data from transaction results.
 */

import { logError } from './errors';

/**
 * Event structure from transaction results.
 */
export interface TxEvent {
  type: string;
  attributes: readonly { key: string; value: string }[];
}

/**
 * Extract an attribute value from transaction events.
 *
 * @param events - Array of transaction events
 * @param eventType - The event type to search for (e.g., 'lease_created')
 * @param attributeKey - The attribute key to extract (e.g., 'lease_uuid')
 * @returns The attribute value if found, undefined otherwise
 */
export function getEventAttribute(
  events: readonly TxEvent[],
  eventType: string,
  attributeKey: string
): string | undefined {
  for (const event of events) {
    if (event.type === eventType) {
      for (const attr of event.attributes) {
        if (attr.key === attributeKey) {
          return attr.value;
        }
      }
    }
  }
  return undefined;
}

/**
 * Extract lease UUID from a create-lease transaction result.
 * Looks for the UUID in transaction events using multiple fallback strategies.
 *
 * @param result - The transaction result object
 * @returns The lease UUID if found, null otherwise
 */
export function extractLeaseUuid(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;

  const obj = result as Record<string, unknown>;

  try {
    // Strategy 1: Look in top-level events array
    const events = obj.events as TxEvent[] | undefined;
    if (events) {
      const uuid = getEventAttribute(events, 'lease_created', 'lease_uuid');
      if (uuid) return uuid;

      // Also check for 'uuid' key as fallback
      const altUuid = getEventAttribute(events, 'lease_created', 'uuid');
      if (altUuid) return altUuid;
    }

    // Strategy 2: Check the response data directly
    const data = obj.data as Record<string, unknown> | undefined;
    if (data && typeof data.lease_uuid === 'string') {
      return data.lease_uuid;
    }

    // Strategy 3: Check parsed logs (some cosmos SDK versions use this format)
    const logs = obj.logs as
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
  } catch (err) {
    logError('extractLeaseUuid', 'Failed to parse TX result', err);
    return null;
  }
}
