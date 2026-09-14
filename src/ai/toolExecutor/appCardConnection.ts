import { z } from 'zod';
import type { AppCardConnection } from '../../contexts/aiTypes';
import type { AppEntry } from '../../registry/appRegistry';
import type { ConnectionDetails } from '../../api/provider-api';
import { logError } from '../../utils/errors';
import { normalizePortMapping } from './helpers';

const ports = z.record(z.string(), z.unknown()).transform((value) => {
  let malformed = false;
  const normalized = Object.fromEntries(Object.entries(value).flatMap(([key, mapping]) => {
    const normalized = normalizePortMapping(mapping);
    if (!normalized) {
      if (normalized === undefined) malformed = true;
      return [];
    }
    return [[key, normalized]];
  }));
  // A malformed inventory is not evidence of an internal-only service.
  return malformed && Object.keys(normalized).length === 0 ? undefined : normalized;
}).optional().catch(undefined);
const instance = z.object({ fqdn: z.string().optional().catch(undefined), ports });
const service = instance.extend({
  instances: z.array(z.unknown()).transform((values) => {
    const normalized = values.flatMap((value) => {
      const parsed = instance.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
    return values.length > 0 && normalized.length === 0 ? undefined : normalized;
  }).optional().catch(undefined),
});
const connectionSchema = service.extend({
  host: z.string().optional().catch(undefined),
  services: z.record(z.string(), z.unknown()).transform((values) =>
    Object.fromEntries(Object.entries(values).flatMap(([name, value]) => {
      const parsed = service.safeParse(value);
      return parsed.success ? [[name, parsed.data]] : [];
    })),
  ).optional().catch(undefined),
});

/** Registry connections can contain older provider shapes; only render validated fields. */
export function appCardConnection(
  connection: AppEntry['connection'] | ConnectionDetails,
  serviceNames?: readonly string[],
  flatServiceName?: string,
): AppCardConnection | undefined {
  if (!connection) return undefined;
  const parsed = connectionSchema.safeParse(connection);
  if (!parsed.success) {
    logError('appCardConnection', parsed.error);
    return undefined;
  }
  const normalized = parsed.data;
  if (!serviceNames?.length) return normalized;
  const reportedNames = Object.keys(normalized.services ?? {});
  if (reportedNames.length > 0) {
    // Lease items can be only partially named. Preserve the provider's named
    // records, but do not attribute ambiguous hoisted fields after a rename.
    return reportedNames.some((name) => !serviceNames.includes(name))
      ? { host: normalized.host, services: normalized.services }
      : normalized;
  }
  if (flatServiceName && connection.services === undefined) {
    const { host, ...flat } = normalized;
    return { host, services: { [flatServiceName]: flat } };
  }
  return normalized;
}
