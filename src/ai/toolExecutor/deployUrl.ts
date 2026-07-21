/**
 * App-URL resolution after deploy/restart/update.
 *
 * Extracted verbatim from compositeTransactions.ts (ENG-576 refactor split).
 * Pure code motion — shapes the app URL from provider connection info + fred status.
 */

import { extractPrimaryServicePorts, formatConnectionUrl, parseContainerPort, TCP_ONLY_PORTS } from './helpers';
import { isValidFqdn } from '../../utils/connection';
import type { FredLeaseStatus } from '../../api/fred';
import { getLeaseConnectionInfo, type ConnectionDetails } from '../../api/provider-api';
import { asLeaseUuid } from '@manifest-network/manifest-sdk';
import { logError } from '../../utils/errors';
import type { SigningContext } from './types';

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
function rewriteFredEndpoint(endpointUrl: string, portKey: string): string {
  try {
    const parsed = new URL(endpointUrl);
    const hostPort = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;

    if (!isDnsHostname(parsed.hostname)) return hostPort;

    const containerPort = parseContainerPort(portKey);
    if (containerPort != null && TCP_ONLY_PORTS.has(containerPort)) {
      return hostPort;
    }
    // HTTP service: https://fqdn (Traefik on 443)
    return `https://${parsed.hostname}`;
  } catch { /* not a valid URL — return as-is */ }
  return endpointUrl;
}

/**
 * Extract URL from fred status data (endpoints or instances).
 * This data is already available from polling — no extra API call needed.
 * Returns the first endpoint URL, or constructs one from instance ports + host.
 */
export function extractUrlFromFredStatus(
  fredStatus: FredLeaseStatus,
  host?: string
): string | undefined {
  // endpoints: Record<string, string> — full URLs like "http://host:port"
  if (fredStatus.endpoints) {
    const firstKey = Object.keys(fredStatus.endpoints)[0];
    const firstEndpoint = firstKey ? fredStatus.endpoints[firstKey] : undefined;
    if (firstKey && firstEndpoint) return rewriteFredEndpoint(firstEndpoint, firstKey);
  }

  // instances: ports as Record<string, number> — just port numbers
  if (fredStatus.instances && host) {
    for (const instance of fredStatus.instances) {
      if (instance.ports) {
        const firstPort = Object.values(instance.ports)[0];
        if (typeof firstPort === 'number') {
          return `${host}:${firstPort}`;
        }
      }
    }
  }

  // Stack services: extract primary service port
  if (fredStatus.services && host) {
    const primary = extractPrimaryServicePorts(fredStatus.services);
    if (primary) {
      const firstPort = Object.values(primary.ports)[0];
      if (typeof firstPort === 'number') {
        return `${host}:${firstPort}`;
      }
    }
  }

  return undefined;
}

/**
 * Resolve the app URL after successful deployment.
 * Priority: info endpoint (has port mappings) > fred status > connection endpoint.
 */
export async function resolveAppUrl(
  providerUrl: string,
  leaseUuid: string,
  fredStatus: FredLeaseStatus,
  _address: string,
  signing: SigningContext | undefined,
  logContext: string
): Promise<{ url?: string; connection?: ConnectionDetails }> {
  // 1. Try connection endpoint (has proper host + port mappings)
  if (signing) {
    try {
      const token = await signing.authTokens.getAuthToken(asLeaseUuid(leaseUuid));
      const connResponse = await getLeaseConnectionInfo(providerUrl, leaseUuid, token);
      if (connResponse.connection) {
        const connection = connResponse.connection;
        // Ports may be at top level or nested inside instances[0].ports
        let ports: Record<string, unknown> | undefined =
          connection.ports ?? connection.instances?.[0]?.ports;

        // Stack deployments: ports nested under services.<name>.instances[0].ports
        let fqdn = connection.fqdn;
        if (!ports && connection.services) {
          const primary = extractPrimaryServicePorts(connection.services);
          if (primary) {
            ports = primary.ports;
            // Promote primary service's FQDN to top-level for formatConnectionUrl
            if (!fqdn) {
              const svc = connection.services[primary.serviceName];
              fqdn = svc?.fqdn ?? svc?.instances?.[0]?.fqdn;
            }
          }
        }

        const withPorts = { ...connection, ports, fqdn };
        const url = formatConnectionUrl(connection.host, withPorts);
        if (url || withPorts.ports) return { url, connection: withPorts };
      }
    } catch (error) {
      logError(`${logContext}.connection`, error);
    }
  }

  // 2. Fall back to fred status data (endpoints/instances)
  // extractUrlFromFredStatus already rewrites FQDN HTTP endpoints to https://fqdn
  const fredUrl = extractUrlFromFredStatus(fredStatus);
  if (fredUrl) {
    return { url: fredUrl };
  }

  return {};
}
