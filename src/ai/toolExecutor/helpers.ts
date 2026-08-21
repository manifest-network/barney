/**
 * Shared helper functions for tool executors.
 * Extracted from compositeTransactions to avoid peer-dependency from compositeQueries.
 */

import { failureDetail, type ConnectionDetails, type FredFailureSource } from '@manifest-network/manifest-sdk/deploy';

import { isValidFqdn } from '../../utils/connection';
import { sanitizeForDisplay } from '../../utils/sanitizeText';

/** Service names that indicate a primary (user-facing) service in a stack. */
const PRIMARY_SERVICE_NAMES = new Set(['web', 'app', 'frontend', 'ui']);

/** Service names that indicate backend infrastructure (not user-facing). */
export const BACKEND_SERVICE_NAMES = new Set(['db', 'database', 'postgres', 'mysql', 'redis', 'mongo']);

/**
 * Extract the "primary" service's ports from a stack services map.
 * Priority:
 *  1. Service named web/app/frontend/ui
 *  2. First non-backend service with ports (skip db, postgres, redis, etc.)
 *  3. Any service with ports
 */
export function extractPrimaryServicePorts(
  services: Record<string, { ports?: Record<string, unknown>; instances?: readonly { ports?: Record<string, unknown> }[] }>
): { serviceName: string; ports: Record<string, unknown> } | undefined {
  const entries = Object.entries(services);
  if (entries.length === 0) return undefined;

  const getPorts = (svc: { ports?: Record<string, unknown>; instances?: readonly { ports?: Record<string, unknown> }[] }): Record<string, unknown> | undefined =>
    svc.ports ?? svc.instances?.[0]?.ports;

  // 1. Named primary service
  for (const [name, svc] of entries) {
    if (PRIMARY_SERVICE_NAMES.has(name)) {
      const ports = getPorts(svc);
      if (ports && Object.keys(ports).length > 0) return { serviceName: name, ports };
    }
  }

  // 2. First non-backend service with ports
  for (const [name, svc] of entries) {
    if (!BACKEND_SERVICE_NAMES.has(name)) {
      const ports = getPorts(svc);
      if (ports && Object.keys(ports).length > 0) return { serviceName: name, ports };
    }
  }

  // 3. Any service with ports
  for (const [name, svc] of entries) {
    const ports = getPorts(svc);
    if (ports && Object.keys(ports).length > 0) return { serviceName: name, ports };
  }

  return undefined;
}

/**
 * Extract port number from a port mapping value.
 * Handles multiple formats the provider API may return:
 *  - Our typed format:   { host_ip: "0.0.0.0", host_port: 12345 }
 *  - Docker PascalCase:  { HostIp: "0.0.0.0", HostPort: "12345" }
 *  - Docker array:       [{ HostIp: "0.0.0.0", HostPort: "12345" }]
 *  - Plain number:       12345
 */
function extractPort(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') { const n = parseInt(value, 10); return isNaN(n) ? undefined : n; }

  // Array — take first element
  let obj = value;
  if (Array.isArray(obj)) obj = obj[0];

  if (obj && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    // snake_case (our interface)
    if (rec.host_port != null) {
      const n = typeof rec.host_port === 'number' ? rec.host_port : parseInt(String(rec.host_port), 10);
      if (!isNaN(n)) return n;
    }
    // PascalCase (Docker native)
    if (rec.HostPort != null) {
      const n = typeof rec.HostPort === 'number' ? rec.HostPort : parseInt(String(rec.HostPort), 10);
      if (!isNaN(n)) return n;
    }
  }
  return undefined;
}

// TODO: Replace this hard-coded set with an automated signal from the provider
// API (e.g., a protocol field on port mappings) so we don't have to maintain a
// manual list of non-HTTP ports.
/** Container ports that require direct TCP access (not HTTP-routable by Traefik). */
export const TCP_ONLY_PORTS = new Set([
  5432,  // PostgreSQL
  3306,  // MySQL / MariaDB
  6379,  // Redis / Valkey
  27017, // MongoDB
  11211, // Memcached
  5672,  // RabbitMQ (AMQP)
  4222,  // NATS
  7687,  // Neo4j Bolt
  9300,  // Elasticsearch transport
  1433,  // MSSQL
  26257, // CockroachDB
]);

/** Parse container port number from a Docker port key like "5432/tcp". */
export function parseContainerPort(portKey: string): number | undefined {
  const m = portKey.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * Build a connection endpoint from host/FQDN + port mappings.
 *
 * When an FQDN is present, Traefik terminates TLS on 443 and routes by
 * subdomain — so HTTP services return the bare FQDN (no port).
 * Non-HTTP services (databases, brokers) need the Docker host-mapped port
 * because Traefik doesn't route raw TCP by subdomain.
 */
export function formatConnectionUrl(
  host: string | undefined,
  // Accept any shape — the port values may not match our PortMapping interface
  connection?: { host: string; fqdn?: string; ports?: Record<string, unknown>; metadata?: Record<string, string> }
): string | undefined {
  // FQDN present — Traefik routes HTTP services on 443 by subdomain
  if (connection?.fqdn && isValidFqdn(connection.fqdn)) {
    if (connection.ports) {
      const firstKey = Object.keys(connection.ports)[0];
      const containerPort = firstKey ? parseContainerPort(firstKey) : undefined;
      // Non-HTTP service: need direct host:port access
      if (containerPort != null && TCP_ONLY_PORTS.has(containerPort)) {
        const hostPort = extractPort(Object.values(connection.ports)[0]);
        if (hostPort != null) return `${connection.fqdn}:${hostPort}`;
      }
    }
    // HTTP service (or no ports): https://fqdn — Traefik TLS on 443
    return `https://${connection.fqdn}`;
  }

  // Try port mappings — prefer connection.host (hostname) over host_ip (raw IP)
  if (connection?.ports) {
    const firstEntry = Object.values(connection.ports)[0];
    const port = extractPort(firstEntry);
    if (port != null) {
      const h = connection.host || host;
      if (!h) return undefined;
      const bareHost = h.replace(/^https?:\/\//, '');
      return `${bareHost}:${port}`;
    }
  }

  // Fallback: extract host[:port] from metadata URL hint (strip scheme, path, query, userinfo)
  if (connection?.metadata?.url) {
    try {
      const parsed = new URL(connection.metadata.url);
      return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    } catch {
      // Not a valid URL — strip scheme and return as-is
      return connection.metadata.url.replace(/^https?:\/\//, '');
    }
  }

  // Last resort: bare host
  if (!host) return undefined;
  return host.replace(/^https?:\/\//, '');
}

/**
 * Shape an app URL from a DeployResult.connection with no extra API call.
 * Mirrors resolveAppUrl's connection block: ports = top-level ?? instances[0]
 * ?? primary-stack-service; FQDN promoted from the primary service when absent.
 * Returns undefined when neither a URL nor ports can be derived — caller then
 * falls back to resolveAppUrl (the network path).
 */
export function deriveUrlFromConnection(
  connection: ConnectionDetails,
): { url?: string; connection: ConnectionDetails } | undefined {
  let ports: Record<string, unknown> | undefined =
    connection.ports ?? connection.instances?.[0]?.ports;

  let fqdn = connection.fqdn;
  if (!ports && connection.services) {
    const primary = extractPrimaryServicePorts(connection.services);
    if (primary) {
      ports = primary.ports;
      if (!fqdn) {
        const svc = connection.services[primary.serviceName];
        fqdn = svc?.fqdn ?? svc?.instances?.[0]?.fqdn;
      }
    }
  }

  const withPorts = { ...connection, ports, fqdn };
  const url = formatConnectionUrl(connection.host, withPorts);
  if (url || withPorts.ports) return { url, connection: withPorts };
  return undefined;
}

// Re-export from shared module so existing tool-executor consumers don't break.
export { collectInstanceUrls } from '../../utils/connection';

/** Cap on a rendered failure tail. Matches mono's own `MESSAGE_MAX`
 *  (packages/fred/src/failure-reason.ts): the sanitizer's 64-code-point default
 *  bisects fred's composed rollback suffixes and image references. */
export const FAILURE_DETAIL_CHARS = 256;

/**
 * One-line, display-safe failure tail for a fred `/status` or `/provision`
 * document, or `fallback` when the document carries no failure signal.
 *
 * `failureDetail` prefers fred v0.13.0's curated `reason`/`message` pair and
 * falls back to the deprecated `last_error`, so both provider eras work — never
 * read either field directly at a display site. Only the human-facing copy is
 * sanitized; callers keep the RAW value for logic (see the update rollback gate).
 */
export function failureText(source: FredFailureSource, fallback: string): string {
  const detail = failureDetail(source);
  return detail === undefined ? fallback : sanitizeForDisplay(detail, FAILURE_DETAIL_CHARS);
}
