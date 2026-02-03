/**
 * Provider API client for fetching lease connection info and health status.
 * Uses ADR-036 off-chain signatures for authentication.
 */

import { logError } from '../utils/errors';
import { parseHttpUrl, isUrlSsrfSafe } from '../utils/url';
import { HEALTH_CHECK_TIMEOUT_MS } from '../config/constants';

/**
 * Validates that a provider API URL is safe to use.
 * Prevents SSRF attacks by ensuring URL is well-formed http(s) and not pointing
 * to private/internal addresses (in production).
 */
function validateProviderUrl(url: string): URL {
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    throw new Error(`Invalid provider API URL: ${url || '(empty)'}`);
  }

  if (!isUrlSsrfSafe(parsed)) {
    throw new Error('Provider API URL cannot point to private/internal addresses');
  }

  return parsed;
}

/**
 * Build a fetch URL and headers for provider API requests.
 * In development, routes through the CORS proxy with X-Proxy-Target header.
 */
function buildProviderFetchArgs(
  baseUrl: string,
  path: string,
  extraHeaders?: Record<string, string>
): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...extraHeaders };

  if (import.meta.env.DEV) {
    headers['X-Proxy-Target'] = baseUrl;
    return { url: `/proxy-provider${path}`, headers };
  }

  return { url: `${baseUrl}${path}`, headers };
}

export interface ProviderHealthResponse {
  status: 'healthy' | 'unhealthy';
  provider_uuid: string;
  checks?: {
    chain?: {
      status: string;
    };
  };
}

/**
 * Port mapping from container port to host binding.
 */
export interface PortMapping {
  host_ip: string;
  host_port: number;
}

/**
 * Connection details returned by the provider API.
 */
export interface ConnectionDetails {
  host: string;
  ports?: Record<string, PortMapping>;
  protocol?: string;
  metadata?: Record<string, string>;
}

/**
 * Lease connection response from the provider API.
 * Matches fred's ConnectionResponse structure.
 */
export interface LeaseConnectionResponse {
  lease_uuid: string;
  tenant: string;
  provider_uuid: string;
  connection: ConnectionDetails;
}

export interface AuthToken {
  tenant: string;
  lease_uuid: string;
  timestamp: number;
  pub_key: string;
  signature: string;
}

export interface AuthTokenWithMetaHash extends AuthToken {
  meta_hash: string;
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
 */
export function createAuthToken(
  tenant: string,
  leaseUuid: string,
  timestamp: number,
  pubKeyBase64: string,
  signatureBase64: string
): string {
  const token: AuthToken = {
    tenant,
    lease_uuid: leaseUuid,
    timestamp,
    pub_key: pubKeyBase64,
    signature: signatureBase64,
  };

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
  // Validate and normalize the API URL
  const validatedUrl = validateProviderUrl(providerApiUrl);
  const baseUrl = validatedUrl.origin + validatedUrl.pathname.replace(/\/$/, '');

  const encodedLeaseUuid = encodeURIComponent(leaseUuid);
  const { url, headers } = buildProviderFetchArgs(
    baseUrl,
    `/v1/leases/${encodedLeaseUuid}/connection`,
    { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
  );

  const response = await fetch(url, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Provider API error (${response.status}): ${errorText}`);
  }

  return response.json();
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

  // Validate the URL before using it
  let validatedUrl: URL;
  try {
    validatedUrl = validateProviderUrl(providerApiUrl);
  } catch (error) {
    logError('provider-api.getProviderHealth.validateUrl', error);
    return null;
  }

  const baseUrl = validatedUrl.origin + validatedUrl.pathname.replace(/\/$/, '');

  const { url, headers } = buildProviderFetchArgs(baseUrl, '/health');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Link external abort signal if provided
  let abortHandler: (() => void) | null = null;
  if (abortSignal) {
    abortHandler = () => controller.abort();
    abortSignal.addEventListener('abort', abortHandler);
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch (error) {
    logError('provider-api.getProviderHealth.fetch', error);
    return null;
  } finally {
    clearTimeout(timeoutId);
    // Clean up abort listener to prevent memory leak
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener('abort', abortHandler);
    }
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
 * Creates a base64-encoded auth token for lease data upload.
 * Includes meta_hash for payload verification.
 */
export function createLeaseDataAuthToken(
  tenant: string,
  leaseUuid: string,
  metaHashHex: string,
  timestamp: number,
  pubKeyBase64: string,
  signatureBase64: string
): string {
  const token: AuthTokenWithMetaHash = {
    tenant,
    lease_uuid: leaseUuid,
    meta_hash: metaHashHex,
    timestamp,
    pub_key: pubKeyBase64,
    signature: signatureBase64,
  };

  return btoa(JSON.stringify(token));
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
  // Validate and normalize the API URL
  const validatedUrl = validateProviderUrl(providerApiUrl);
  const baseUrl = validatedUrl.origin + validatedUrl.pathname.replace(/\/$/, '');

  const encodedLeaseUuid = encodeURIComponent(leaseUuid);
  const { url, headers } = buildProviderFetchArgs(
    baseUrl,
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
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Failed to upload lease data (${response.status}): ${errorText}`);
  }
}
