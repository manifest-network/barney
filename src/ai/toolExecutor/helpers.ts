/**
 * Shared helper functions for tool executors.
 * Extracted from compositeTransactions to avoid peer-dependency from compositeQueries.
 */

import { isValidFqdn } from '../../utils/connection';

/** Service names that indicate a primary (user-facing) service in a stack. */
const PRIMARY_SERVICE_NAMES = new Set(['web', 'app', 'frontend', 'ui']);

/** Service names that indicate backend infrastructure (not user-facing). */
export const BACKEND_SERVICE_NAMES = new Set(['db', 'database', 'postgres', 'mysql', 'redis', 'mongo']);

/** Well-known container ports that speak non-HTTP protocols (databases, caches, message queues). */
const NON_HTTP_CONTAINER_PORTS = new Set([
  1433,  // MSSQL
  3306,  // MySQL / MariaDB
  4222,  // NATS
  5432,  // PostgreSQL
  5672,  // RabbitMQ (AMQP)
  6379,  // Redis
  7687,  // Neo4j (Bolt)
  9300,  // Elasticsearch transport
  11211, // Memcached
  27017, // MongoDB
]);

/**
 * Detect whether all container ports in a port mapping are non-HTTP services.
 * Uses the container port key (e.g. "5432/tcp") to classify protocol.
 */
export function isNonHttpService(ports: Record<string, unknown>): boolean {
  const keys = Object.keys(ports);
  if (keys.length === 0) return false;
  return keys.every(key => {
    const portNum = parseInt(key, 10);
    return !isNaN(portNum) && NON_HTTP_CONTAINER_PORTS.has(portNum);
  });
}

/**
 * Extract the "primary" service's ports from a stack services map.
 * Priority:
 *  1. Service named web/app/frontend/ui
 *  2. First non-backend service with ports (skip db, postgres, redis, etc.)
 *  3. Any service with ports
 */
export function extractPrimaryServicePorts(
  services: Record<string, { ports?: Record<string, unknown>; instances?: { ports?: Record<string, unknown> }[] }>
): { serviceName: string; ports: Record<string, unknown> } | undefined {
  const entries = Object.entries(services);
  if (entries.length === 0) return undefined;

  const getPorts = (svc: { ports?: Record<string, unknown>; instances?: { ports?: Record<string, unknown> }[] }): Record<string, unknown> | undefined =>
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

export function formatConnectionUrl(
  host: string | undefined,
  // Accept any shape — the port values may not match our PortMapping interface
  connection?: { host: string; fqdn?: string; ports?: Record<string, unknown>; metadata?: Record<string, string> }
): string | undefined {
  const nonHttp = connection?.ports ? isNonHttpService(connection.ports) : false;

  // Prefer FQDN — provider-assigned domain with TLS termination
  if (connection?.fqdn && isValidFqdn(connection.fqdn)) {
    // Non-HTTP: return fqdn:host_port (no protocol)
    if (nonHttp && connection.ports) {
      const port = extractPort(Object.values(connection.ports)[0]);
      return port != null ? `${connection.fqdn}:${port}` : connection.fqdn;
    }
    return `https://${connection.fqdn}`;
  }

  let url = host;

  // Try port mappings — use port number but prefer connection.host (hostname) over host_ip (raw IP)
  if (connection?.ports) {
    const firstEntry = Object.values(connection.ports)[0];
    const port = extractPort(firstEntry);
    if (port != null) {
      const h = connection.host || host;
      if (!h) return undefined;
      // Strip any existing protocol from h before appending port
      const bareHost = h.replace(/^https?:\/\//, '');

      // Non-HTTP: return host:port without protocol prefix
      if (nonHttp) {
        return `${bareHost}:${port}`;
      }

      if (port === 80 || port === 443) {
        url = bareHost;
      } else {
        url = `${bareHost}:${port}`;
      }
    }
  }

  // Fallback: check metadata for a URL hint
  if (url === host && connection?.metadata?.url) {
    url = connection.metadata.url;
  }

  if (!url) return undefined;

  // Add protocol if missing: https by default, http only for localhost/loopback
  if (!/^https?:\/\//i.test(url)) {
    // Strip protocol-detection to the hostname (before any port)
    const hostPart = url.replace(/:\d+$/, '');
    const isLocal = hostPart === 'localhost' || hostPart === '127.0.0.1' || hostPart === '::1';
    url = `${isLocal ? 'http' : 'https'}://${url}`;
  }

  return url;
}

// Re-export from shared module so existing tool-executor consumers don't break.
export { collectInstanceUrls } from '../../utils/connection';
