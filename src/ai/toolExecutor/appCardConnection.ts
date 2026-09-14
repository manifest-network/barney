import { z } from 'zod';
import type { AppCardConnection } from '../../contexts/aiTypes';
import type { AppEntry } from '../../registry/appRegistry';
import { logError } from '../../utils/errors';
import { extractPort } from './helpers';

const ports = z.record(z.string(), z.unknown()).transform((value) => {
  const normalized = Object.fromEntries(Object.entries(value).flatMap(([key, mapping]) => {
    const host_port = extractPort(mapping);
    if (host_port === undefined) return [];
    const raw = Array.isArray(mapping) ? mapping[0] : mapping;
    const host = raw && typeof raw === 'object' ? raw.host_ip ?? raw.HostIp : undefined;
    return [[key, { host_port, ...(typeof host === 'string' ? { host_ip: host } : {}) }]];
  }));
  // A malformed inventory is not evidence of an internal-only service.
  return Object.keys(value).length > 0 && Object.keys(normalized).length === 0 ? undefined : normalized;
}).optional().catch(undefined);
const instance = z.object({ fqdn: z.string().optional().catch(undefined), ports });
const service = instance.extend({
  instances: z.array(z.unknown()).transform((values) => values.flatMap((value) => {
    const parsed = instance.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  })).optional().catch(undefined),
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
  connection: AppEntry['connection'],
  serviceNames?: readonly string[],
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
    const services = Object.fromEntries(Object.entries(normalized.services!).filter(([name]) => serviceNames.includes(name)));
    // Hoisted flat fields may belong to an old service after a rename. Retain
    // only the named records that still match the current lease/manifest.
    return reportedNames.some((name) => !serviceNames.includes(name))
      ? { host: normalized.host, services }
      : { ...normalized, services };
  }
  if (serviceNames.length === 1 && connection.services === undefined) {
    const { host, ...flat } = normalized;
    return { host, services: { [serviceNames[0]]: flat } };
  }
  return normalized;
}
