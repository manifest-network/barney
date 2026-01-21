/**
 * Provider API client for fetching lease connection info.
 * Uses ADR-036 off-chain signatures for authentication.
 */

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

/**
 * Creates the message to sign for ADR-036 authentication.
 */
export function createSignMessage(tenant: string, leaseUuid: string, timestamp: number): string {
  return `${tenant}:${leaseUuid}:${timestamp}`;
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
  // Normalize the API URL (remove trailing slash)
  const baseUrl = providerApiUrl.replace(/\/$/, '');

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
