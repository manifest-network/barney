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
