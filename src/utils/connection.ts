/**
 * Connection URL utilities shared across UI and tool-executor layers.
 * Moved here from ai/toolExecutor/helpers.ts to avoid coupling UI
 * components to AI tool-executor internals.
 */

import * as ipaddr from 'ipaddr.js';

/** Empty records can result from SDK filtering and must not hide another source. */
export function nonEmptyPorts<Port>(ports: Record<string, Port> | undefined): Record<string, Port> | undefined {
  return ports && Object.keys(ports).length > 0 ? ports : undefined;
}

/** RFC 952 / RFC 1123 hostname pattern: labels of alphanumeric + hyphens, dot-separated. */
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Validate that a string looks like a safe hostname (no path, port, or protocol injection). */
export function isValidFqdn(value: string): boolean {
  return HOSTNAME_RE.test(value) && value.length <= 253;
}

/**
 * Canonical FQDN normalization: trim whitespace, strip a trailing dot, lowercase.
 * DNS hostnames are case-insensitive (RFC 4343); the trailing dot marks the root
 * and isn't part of the relative name. Use this anywhere two FQDN strings are
 * being compared or sent over the wire.
 */
export function normalizeFqdn(value: string): string {
  return value.trim().replace(/\.$/, '').toLowerCase();
}

function formatEndpointHost(value?: string): string | undefined {
  if (!value) return undefined;
  const host = value.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host)) {
    if (ipaddr.process(host).range() === 'unspecified') return undefined;
    return host.includes(':') ? `[${host}]` : host;
  }
  return isValidFqdn(value) ? value : undefined;
}

/** Wildcard binds need the reported Docker host, not an HTTP-routing FQDN. */
export function formatPortEndpoint(
  mapping: { host_ip?: string; host_port: number },
  connectionHost?: string,
): string | undefined {
  if (!Number.isInteger(mapping.host_port) || mapping.host_port <= 0 || mapping.host_port > 65535) return undefined;
  const host = formatEndpointHost(mapping.host_ip) ?? formatEndpointHost(connectionHost);
  return host ? `${host}:${mapping.host_port}` : undefined;
}

/**
 * Collect per-instance FQDNs from a connection object.
 * For flat leases: collects from `connection.instances`.
 * For stack leases: collects from each service's instances.
 * Returns empty array if ≤1 unique FQDN (single-instance doesn't need extra URLs).
 * FQDNs that fail hostname validation are silently skipped.
 */
export function collectInstanceUrls(
  connection?: { instances?: { fqdn?: string }[]; services?: Record<string, { instances?: { fqdn?: string }[] }> }
): string[] {
  if (!connection) return [];

  const urls: string[] = [];

  // Flat leases: collect from top-level instances
  if (connection.instances) {
    for (const inst of connection.instances) {
      if (inst.fqdn && isValidFqdn(inst.fqdn)) {
        urls.push(inst.fqdn);
      }
    }
  }

  // Stack leases: collect from each service's instances
  if (connection.services) {
    for (const svc of Object.values(connection.services)) {
      if (svc.instances) {
        for (const inst of svc.instances) {
          if (inst.fqdn && isValidFqdn(inst.fqdn)) {
            urls.push(inst.fqdn);
          }
        }
      }
    }
  }

  // Only return if there are multiple unique FQDNs
  const unique = [...new Set(urls)];
  return unique.length > 1 ? unique : [];
}

/**
 * Resolve the provider-issued CNAME target for a deployed app/service.
 * - Stack: `connection.services[serviceName].fqdn` (or the first instance's fqdn)
 * - Single-service: `connection.fqdn` (or the first instance's fqdn)
 * Validates with `isValidFqdn` and strips a trailing dot. Returns undefined if
 * no usable hostname is found.
 */
export function resolveExpectedCnameTarget(
  connection:
    | {
        readonly fqdn?: string;
        readonly instances?: readonly { readonly fqdn?: string }[];
        readonly services?: Readonly<Record<string, unknown>>;
      }
    | undefined,
  serviceName: string,
): string | undefined {
  if (!connection) return undefined;

  const normalize = (value?: string): string | undefined => {
    if (!value) return undefined;
    const stripped = value.replace(/\.$/, '');
    return isValidFqdn(stripped) ? stripped : undefined;
  };

  if (serviceName !== '' && connection.services) {
    const svcRaw = connection.services[serviceName];
    if (svcRaw && typeof svcRaw === 'object') {
      const svc = svcRaw as { readonly fqdn?: string; readonly instances?: readonly { readonly fqdn?: string }[] };
      const svcFqdn = normalize(svc.fqdn) ?? normalize(svc.instances?.[0]?.fqdn);
      if (svcFqdn) return svcFqdn;
    }
  }

  return normalize(connection.fqdn) ?? normalize(connection.instances?.[0]?.fqdn);
}
