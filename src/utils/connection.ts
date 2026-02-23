/**
 * Connection URL utilities shared across UI and tool-executor layers.
 * Moved here from ai/toolExecutor/helpers.ts to avoid coupling UI
 * components to AI tool-executor internals.
 */

/** RFC 952 / RFC 1123 hostname pattern: labels of alphanumeric + hyphens, dot-separated. */
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Validate that a string looks like a safe hostname (no path, port, or protocol injection). */
export function isValidFqdn(value: string): boolean {
  return HOSTNAME_RE.test(value) && value.length <= 253;
}

/**
 * Collect per-instance FQDN URLs from a connection object.
 * For flat leases: collects `https://{inst.fqdn}` from `connection.instances`.
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
        urls.push(`https://${inst.fqdn}`);
      }
    }
  }

  // Stack leases: collect from each service's instances
  if (connection.services) {
    for (const svc of Object.values(connection.services)) {
      if (svc.instances) {
        for (const inst of svc.instances) {
          if (inst.fqdn && isValidFqdn(inst.fqdn)) {
            urls.push(`https://${inst.fqdn}`);
          }
        }
      }
    }
  }

  // Only return if there are multiple unique FQDNs
  const unique = [...new Set(urls)];
  return unique.length > 1 ? unique : [];
}
