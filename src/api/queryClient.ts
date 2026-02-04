import { createLCDClient } from '@manifest-network/manifestjs/dist/codegen/liftedinit/lcd';
import { REST_URL } from './config';

type LCDQueryClient = Awaited<ReturnType<typeof createLCDClient>>;

let clientPromise: Promise<LCDQueryClient> | null = null;

export function getQueryClient(): Promise<LCDQueryClient> {
  if (!clientPromise) {
    clientPromise = createLCDClient({ restEndpoint: REST_URL });
  }
  return clientPromise;
}

export async function queryWithNotFound<T, D>(queryFn: () => Promise<T>, notFoundDefault: D): Promise<T | D> {
  try {
    return await queryFn();
  } catch (error) {
    if (isNotFoundError(error)) return notFoundDefault;
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'response' in error) {
    const e = error as { response?: { status?: number } };
    return e.response?.status === 404;
  }
  return false;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- LCD returns untyped JSON; centralizes the single `as any` cast */

/**
 * Convert an LCD response through a manifestjs fromAmino converter.
 * Isolates the `as any` cast required because LCD returns untyped JSON.
 */
export function lcdConvert<T>(data: unknown, converter: { fromAmino: (data: any) => T }): T {
  return converter.fromAmino(data as any);
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Fix an enum field on an object returned by LCD.
 * LCD returns enum strings (e.g., "LEASE_STATE_ACTIVE") but TypeScript enum keys
 * are numeric. This applies the fromJSON conversion to the specified field.
 */
export function fixEnumField<T, K extends keyof T>(
  obj: T,
  key: K,
  fromJSON: (value: T[K]) => T[K]
): T {
  return { ...obj, [key]: fromJSON(obj[key]) };
}
