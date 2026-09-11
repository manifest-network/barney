/**
 * App-URL resolution after deploy/restart/update.
 *
 * Shares connection shaping with deploy results and app_status, then falls back
 * to provider status endpoints or instance FQDNs. Direct TCP access requires
 * an assigned host port; HTTP FQDNs route through Traefik on 443.
 */

import { connectionPatch, deriveUrlFromConnection, extractPort, extractPrimaryServicePorts, formatConnectionUrl, parseContainerPort, TCP_ONLY_PORTS } from './helpers';
import { isValidFqdn } from '../../utils/connection';
import type { FredLeaseStatus } from '../../api/fred';
import { getLeaseConnectionInfo, type ConnectionDetails } from '../../api/provider-api';
import { asLeaseUuid } from '@manifest-network/manifest-sdk';
import { logError } from '../../utils/errors';
import type { SigningContext } from './types';
import type { AppEntry } from '../../registry/appRegistry';

/** Refresh the primary endpoint independently of the saved service inventory. */
export function refreshAppConnection(
  status: FredLeaseStatus | undefined,
  connection: ConnectionDetails | undefined,
  previous: Pick<AppEntry, 'url' | 'connection'>,
) {
  const shaped = connection ? deriveUrlFromConnection(connection) : undefined;
  const url = shaped?.url ?? (status ? extractUrlFromFredStatus(status) : undefined);
  const patch = connectionPatch({ url, connection: shaped?.connection ?? connection }, previous);
  return { patch, endpointRefreshed: url !== undefined, connectionRefreshed: patch.connection !== undefined };
}

/** True if the hostname looks like a DNS name (not a bare IPv4 address). */
function isDnsHostname(hostname: string): boolean {
  return isValidFqdn(hostname) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Rewrite a Fred endpoint URL based on container port type and hostname.
 *
 * - FQDN + HTTP port  → `https://fqdn` (Traefik TLS termination)
 * - FQDN + TCP port   → `fqdn:port`    (direct TCP, no protocol)
 * - IP (any port)      → `ip:port`      (bare, no protocol)
 */
function rewriteFredEndpoint(endpointUrl: string, portKey: string): string | undefined {
  try {
    const parsed = new URL(endpointUrl);
    const containerPort = parseContainerPort(portKey);
    if (isDnsHostname(parsed.hostname) && !(containerPort != null && TCP_ONLY_PORTS.has(containerPort))) {
      // HTTP ingress does not use Docker's published host port.
      return `https://${parsed.hostname}`;
    }
    if (parsed.port && extractPort(parsed.port) === undefined) return undefined;
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch { /* A malformed hint supplies no endpoint; try the remaining status data. */ }
  return undefined;
}

function urlFromStatusPorts(
  ports: Record<string, unknown>,
  fqdn?: string,
  host?: string,
): string | undefined {
  // Keep the container port so formatConnectionUrl can distinguish HTTP ingress
  // from direct TCP. A filtered-empty record no longer carries that information.
  if (Object.keys(ports).length === 0) return undefined;
  const connectionHost = fqdn && isValidFqdn(fqdn) ? fqdn : host;
  if (!connectionHost) return undefined;
  return formatConnectionUrl(connectionHost, { host: connectionHost, fqdn, ports });
}

/**
 * Extract URL from fred status data (endpoints or instances).
 * This data is already available from polling — no extra API call needed.
 * Uses provider-reported instance FQDNs when no host is supplied. The provider's
 * API hostname and wildcard host_ip bind address are not workload addresses.
 */
export function extractUrlFromFredStatus(
  fredStatus: FredLeaseStatus,
  host?: string
): string | undefined {
  // endpoints: Record<string, string> — full URLs like "http://host:port"
  if (fredStatus.endpoints) {
    const firstKey = Object.keys(fredStatus.endpoints)[0];
    const firstEndpoint = firstKey ? fredStatus.endpoints[firstKey] : undefined;
    if (firstKey && firstEndpoint) {
      const url = rewriteFredEndpoint(firstEndpoint, firstKey);
      if (url) return url;
    }
  }

  // SDK-validated instance ports carry host_ip / host_port mappings.
  if (fredStatus.instances) {
    for (const instance of fredStatus.instances) {
      if (instance.ports) {
        const url = urlFromStatusPorts(instance.ports, instance.fqdn, host);
        if (url) return url;
      }
    }
  }

  // Stack services: extract primary service port
  if (fredStatus.services) {
    const primary = extractPrimaryServicePorts(fredStatus.services);
    if (primary) {
      const service = fredStatus.services[primary.serviceName];
      return urlFromStatusPorts(primary.ports, service?.instances?.[0]?.fqdn, host);
    }
  }

  return undefined;
}

/**
 * Resolve the app URL after successful deployment.
 * Priority: connection-info endpoint (host + port mappings) > fred status fallback.
 */
export async function resolveAppUrl(
  providerUrl: string,
  leaseUuid: string,
  fredStatus: FredLeaseStatus,
  _address: string,
  signing: SigningContext | undefined,
  logContext: string
): Promise<{ url?: string; connection?: ConnectionDetails }> {
  let connection: ConnectionDetails | undefined;
  // 1. Try connection endpoint (has proper host + port mappings)
  if (signing) {
    try {
      const token = await signing.authTokens.getAuthToken(asLeaseUuid(leaseUuid));
      const connResponse = await getLeaseConnectionInfo(providerUrl, leaseUuid, token);
      connection = connResponse.connection;
      if (connResponse.connection) {
        const shaped = deriveUrlFromConnection(connResponse.connection);
        if (shaped) return shaped;
      }
    } catch (error) {
      logError(`${logContext}.connection`, error);
    }
  }

  // 2. Fall back to fred status data (endpoints/instances)
  // extractUrlFromFredStatus already rewrites FQDN HTTP endpoints to https://fqdn
  const fredUrl = extractUrlFromFredStatus(fredStatus);
  if (fredUrl) {
    return { url: fredUrl, ...(connection ? { connection } : {}) };
  }

  return connection ? { connection } : {};
}
