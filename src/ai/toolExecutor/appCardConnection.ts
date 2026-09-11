import { z } from 'zod';
import type { AppCardConnection } from '../../contexts/aiTypes';
import type { AppEntry } from '../../registry/appRegistry';
import { logError } from '../../utils/errors';

const portMapping = z.object({
  host_ip: z.string(),
  host_port: z.number().int().min(1).max(65535),
});
const ports = z.record(z.string(), z.unknown()).transform((value) =>
  Object.fromEntries(Object.entries(value).flatMap(([key, mapping]) => {
    const parsed = portMapping.safeParse(mapping);
    return parsed.success ? [[key, parsed.data]] : [];
  })),
).optional().catch(undefined);
const instance = z.object({ fqdn: z.string().optional().catch(undefined), ports });
const service = instance.extend({
  instances: z.array(instance.catch({})).optional().catch(undefined),
});
const connectionSchema = service.extend({
  host: z.string(),
  services: z.record(z.string(), service.catch({})).optional().catch(undefined),
});

/** Registry connections can contain older provider shapes; only render validated fields. */
export function appCardConnection(connection: AppEntry['connection']): AppCardConnection | undefined {
  if (!connection) return undefined;
  const parsed = connectionSchema.safeParse(connection);
  if (parsed.success) return parsed.data;
  logError('appCardConnection', parsed.error);
  return undefined;
}
