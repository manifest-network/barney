/**
 * Provider API client for fetching lease connection info and health status.
 * Uses ADR-036 off-chain signatures for authentication.
 */

/**
 * Validates that a provider API URL is safe to use.
 * Prevents SSRF attacks by ensuring URL is well-formed http(s).
 */
function validateProviderUrl(url: string): URL {
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid provider API URL: URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid provider API URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid provider API URL protocol: ${parsed.protocol}`);
  }

  return parsed;
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

export interface ConnectionInfo {
  lease_uuid: string;
  tenant: string;
  provider_uuid: string;
  connection: {
    host: string;
    port: number;
    protocol: string;
    metadata?: Record<string, string>;
  };
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
 */
export async function getLeaseConnectionInfo(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string
): Promise<ConnectionInfo> {
  // Validate and normalize the API URL
  const validatedUrl = validateProviderUrl(providerApiUrl);
  const baseUrl = validatedUrl.origin + validatedUrl.pathname.replace(/\/$/, '');

  // In development, use the proxy to bypass CORS
  // The proxy dynamically routes to the target specified in X-Proxy-Target header
  let url: string;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };

  if (import.meta.env.DEV) {
    url = `/proxy-provider/v1/leases/${leaseUuid}/connection`;
    headers['X-Proxy-Target'] = baseUrl;
  } else {
    url = `${baseUrl}/v1/leases/${leaseUuid}/connection`;
  }

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
  timeoutMs: number = 5000,
  abortSignal?: AbortSignal
): Promise<ProviderHealthResponse | null> {
  if (!providerApiUrl) {
    return null;
  }

  // Validate the URL before using it
  let validatedUrl: URL;
  try {
    validatedUrl = validateProviderUrl(providerApiUrl);
  } catch {
    return null;
  }

  const baseUrl = validatedUrl.origin + validatedUrl.pathname.replace(/\/$/, '');

  let url: string;
  const headers: Record<string, string> = {};

  if (import.meta.env.DEV) {
    url = `/proxy-provider/health`;
    headers['X-Proxy-Target'] = baseUrl;
  } else {
    url = `${baseUrl}/health`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Link external abort signal if provided
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort());
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
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

/**
 * Helper to convert Uint8Array to base64 string.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Helper to convert base64 string to Uint8Array.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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

  let url: string;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${authToken}`,
    'Content-Type': 'application/octet-stream',
  };

  if (import.meta.env.DEV) {
    url = `/proxy-provider/v1/leases/${leaseUuid}/data`;
    headers['X-Proxy-Target'] = baseUrl;
  } else {
    url = `${baseUrl}/v1/leases/${leaseUuid}/data`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: new Blob([payload.buffer as ArrayBuffer]),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Failed to upload lease data (${response.status}): ${errorText}`);
  }
}
