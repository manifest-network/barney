/**
 * Provider API client for fetching lease connection info and health status.
 * Uses ADR-036 off-chain signatures for authentication.
 */

import { z } from 'zod';
import { logError } from '../utils/errors';
import { HEALTH_CHECK_TIMEOUT_MS } from '../config/constants';
import { buildValidatedProviderRequest } from './providerFetch';

/**
 * Typed error for provider API HTTP failures.
 * Carries the HTTP status code so callers can match on `error.status`
 * instead of parsing error message strings.
 */
export class ProviderApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    Object.setPrototypeOf(this, ProviderApiError.prototype);
    this.name = 'ProviderApiError';
    this.status = status;
  }
}

/**
 * Extracts error text from a failed response and throws a ProviderApiError.
 */
async function throwProviderApiError(response: Response, prefix: string): Promise<never> {
  const errorText = await response.text().catch(() => response.statusText);
  throw new ProviderApiError(response.status, `${prefix} (${response.status}): ${errorText}`);
}

export const ProviderHealthResponseSchema = z.object({
  status: z.enum(['healthy', 'unhealthy']),
  provider_uuid: z.string(),
  checks: z.object({
    chain: z.object({ status: z.string() }).optional(),
  }).optional(),
});

export type ProviderHealthResponse = z.infer<typeof ProviderHealthResponseSchema>;

export const PortMappingSchema = z.object({
  host_ip: z.string(),
  host_port: z.number(),
});

export type PortMapping = z.infer<typeof PortMappingSchema>;

export const InstanceInfoSchema = z.object({
  instance_index: z.number(),
  container_id: z.string(),
  image: z.string(),
  status: z.string(),
  ports: z.record(z.string(), PortMappingSchema).optional(),
});

export type InstanceInfo = z.infer<typeof InstanceInfoSchema>;

export const ServiceConnectionDetailsSchema = z.object({
  host: z.string().optional(),
  fqdn: z.string().optional(),
  ports: z.record(z.string(), PortMappingSchema).optional(),
  instances: z.array(InstanceInfoSchema).optional(),
});

export type ServiceConnectionDetails = z.infer<typeof ServiceConnectionDetailsSchema>;

export const ConnectionDetailsSchema = z.object({
  host: z.string(),
  fqdn: z.string().optional(),
  // Port formats vary across providers; extractPort() in helpers.ts handles normalization
  ports: z.record(z.string(), z.unknown()).optional(),
  instances: z.array(InstanceInfoSchema).optional(),
  protocol: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  services: z.record(z.string(), ServiceConnectionDetailsSchema).optional(),
});

export type ConnectionDetails = z.infer<typeof ConnectionDetailsSchema>;

export const LeaseConnectionResponseSchema = z.object({
  lease_uuid: z.string(),
  tenant: z.string(),
  provider_uuid: z.string(),
  connection: ConnectionDetailsSchema,
});

export type LeaseConnectionResponse = z.infer<typeof LeaseConnectionResponseSchema>;

export interface AuthToken {
  tenant: string;
  lease_uuid: string;
  timestamp: number;
  pub_key: string;
  signature: string;
  meta_hash?: string;
}

const MAX_AUTH_TOKEN_AGE_SECONDS = 60;
const MAX_AUTH_TOKEN_FUTURE_SECONDS = 10;

/**
 * Validates that a timestamp is recent enough for auth token use.
 * Rejects timestamps older than 60 seconds or more than 10 seconds in the future.
 */
export function validateAuthTimestamp(timestamp: number): void {
  if (!Number.isFinite(timestamp)) {
    throw new Error('Auth timestamp must be a finite number');
  }

  const now = Math.floor(Date.now() / 1000);
  const age = now - timestamp;

  if (age > MAX_AUTH_TOKEN_AGE_SECONDS) {
    throw new Error(`Auth token expired: timestamp is ${age}s old (max ${MAX_AUTH_TOKEN_AGE_SECONDS}s)`);
  }

  if (age < -MAX_AUTH_TOKEN_FUTURE_SECONDS) {
    throw new Error(`Auth token timestamp is ${-age}s in the future (max ${MAX_AUTH_TOKEN_FUTURE_SECONDS}s)`);
  }
}

/**
 * Creates the message to sign for ADR-036 authentication (connection info).
 */
export function createSignMessage(tenant: string, leaseUuid: string, timestamp: number): string {
  return `${tenant}:${leaseUuid}:${timestamp}`;
}

/**
 * Creates the message to sign for lease data upload (ADR-036).
 * Format: "manifest lease data {lease_uuid} {meta_hash_hex} {unix_timestamp}"
 */
export function createLeaseDataSignMessage(leaseUuid: string, metaHashHex: string, timestamp: number): string {
  return `manifest lease data ${leaseUuid} ${metaHashHex} ${timestamp}`;
}

/**
 * Creates a base64-encoded auth token from the signed data.
 * When metaHashHex is provided, the token includes meta_hash for payload verification.
 */
export function createAuthToken(
  tenant: string,
  leaseUuid: string,
  timestamp: number,
  pubKeyBase64: string,
  signatureBase64: string,
  metaHashHex?: string
): string {
  validateAuthTimestamp(timestamp);

  const token: AuthToken = {
    tenant,
    lease_uuid: leaseUuid,
    timestamp,
    pub_key: pubKeyBase64,
    signature: signatureBase64,
  };

  if (metaHashHex) {
    token.meta_hash = metaHashHex;
  }

  return btoa(JSON.stringify(token));
}

/**
 * Fetches lease connection info from the provider's API.
 * Returns structured connection response from the provider.
 */
export async function getLeaseConnectionInfo(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string
): Promise<LeaseConnectionResponse> {
  const encodedLeaseUuid = encodeURIComponent(leaseUuid);
  const { url, headers } = buildValidatedProviderRequest(
    providerApiUrl,
    `/v1/leases/${encodedLeaseUuid}/connection`,
    { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
  );

  const response = await fetch(url, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    await throwProviderApiError(response, 'Provider API error');
  }

  try {
    const data = await response.json();
    return LeaseConnectionResponseSchema.parse(data);
  } catch (error) {
    if (error instanceof ProviderApiError) throw error;
    throw new ProviderApiError(response.status, 'Provider returned invalid JSON');
  }
}

/**
 * Checks the health status of a provider's API.
 * Returns null if the provider is unreachable.
 */
export async function getProviderHealth(
  providerApiUrl: string,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
  abortSignal?: AbortSignal
): Promise<ProviderHealthResponse | null> {
  if (!providerApiUrl) {
    return null;
  }

  let requestArgs: { url: string; headers: Record<string, string> };
  try {
    requestArgs = buildValidatedProviderRequest(providerApiUrl, '/health');
  } catch (error) {
    logError('provider-api.getProviderHealth.validateUrl', error);
    return null;
  }

  const { url, headers } = requestArgs;

  const signals = [AbortSignal.timeout(timeoutMs)];
  if (abortSignal) signals.push(abortSignal);
  const combinedSignal = AbortSignal.any(signals);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: combinedSignal,
    });

    if (!response.ok) {
      logError('provider-api.getProviderHealth.http', new Error(`Provider health check returned ${response.status}`));
      return null;
    }

    const data: unknown = await response.json();
    const result = ProviderHealthResponseSchema.safeParse(data);
    if (!result.success) {
      logError('provider-api.getProviderHealth.shape', new Error('Provider returned unexpected health response shape'));
      return null;
    }

    return result.data;
  } catch (error) {
    logError('provider-api.getProviderHealth.fetch', error);
    return null;
  }
}

/**
 * Computes SHA-256 hash of the payload and returns it as a hex string.
 * Used to generate meta_hash for lease creation and payload verification.
 *
 * Re-exported from utils/hash.ts for backward compatibility.
 */
export { sha256Hex as computePayloadHash } from '../utils/hash';

/**
 * Validates that a string is a valid SHA-256 hex hash (64 hex characters).
 */
export function isValidMetaHash(hash: string): boolean {
  return /^[0-9a-f]{64}$/i.test(hash);
}


/**
 * Uploads lease payload data to the provider's API.
 * This should be called after creating a lease with a meta_hash.
 *
 * @param providerApiUrl - The provider's API URL
 * @param leaseUuid - The lease UUID
 * @param payload - The raw payload bytes
 * @param authToken - The base64-encoded auth token (with meta_hash)
 */
export async function uploadLeaseData(
  providerApiUrl: string,
  leaseUuid: string,
  payload: Uint8Array,
  authToken: string
): Promise<void> {
  const encodedLeaseUuid = encodeURIComponent(leaseUuid);
  const { url, headers } = buildValidatedProviderRequest(
    providerApiUrl,
    `/v1/leases/${encodedLeaseUuid}/data`,
    { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/octet-stream' },
  );

  const response = await fetch(url, {
    method: 'POST',
    headers,
    // Type assertion needed for TS 5.9 - Blob constructor handles Uint8Array correctly at runtime
    body: new Blob([payload as BlobPart]),
  });

  if (!response.ok) {
    await throwProviderApiError(response, 'Failed to upload lease data');
  }
}
