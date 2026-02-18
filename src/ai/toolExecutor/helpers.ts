/**
 * Shared helper functions for tool executors.
 * Extracted from compositeTransactions to avoid peer-dependency from compositeQueries.
 */

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
  connection?: { host: string; ports?: Record<string, unknown>; metadata?: Record<string, string> }
): string | undefined {
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
