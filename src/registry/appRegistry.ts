/**
 * App Registry — localStorage-backed name→lease mapping, scoped per wallet address.
 *
 * Provides a friendly "app name" layer on top of raw lease UUIDs. Each wallet
 * address gets its own isolated registry keyed as `barney-apps-{address}`.
 */

import { z } from 'zod';
import { logError } from '../utils/errors';

export const APP_STATUSES = ['deploying', 'running', 'stopped', 'failed'] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

export const AppEntrySchema = z.object({
  name: z.string(),
  leaseUuid: z.string(),
  size: z.string(),
  providerUuid: z.string(),
  providerUrl: z.string(),
  createdAt: z.number(),
  url: z.string().optional(),
  connection: z.object({
    host: z.string(),
    fqdn: z.string().optional(),
    ports: z.record(z.string(), z.unknown()).optional(),
    instances: z.array(z.object({ fqdn: z.string().optional() }).passthrough()).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    services: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  status: z.enum(APP_STATUSES),
  manifest: z.string().optional(),
});

export type AppEntry = z.infer<typeof AppEntrySchema>;

/** Name validation: lowercase alphanumeric + hyphens, 1-32 chars, no leading/trailing hyphen */
const APP_NAME_REGEX = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/** Pattern matching env var names that likely contain secrets */
const SENSITIVE_ENV_PATTERN = /password|secret|token|key|credential|api[_-]?key/i;

/**
 * Sanitize a manifest JSON string for localStorage storage.
 * Replaces sensitive env var values with empty strings to avoid persisting secrets.
 * Empty values trigger auto-generation (via generatePassword) on re-deploy.
 */
export function sanitizeManifestForStorage(manifestJson: string): string {
  try {
    const manifest: unknown = JSON.parse(manifestJson);
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      return manifestJson;
    }

    const obj = manifest as Record<string, unknown>;

    // Single-service: sanitize top-level env
    if (obj.env && typeof obj.env === 'object' && !Array.isArray(obj.env)) {
      obj.env = sanitizeEnvObject(obj.env as Record<string, string>);
    }

    // Stack (multi-service): sanitize env inside each service
    if (obj.services && typeof obj.services === 'object' && !Array.isArray(obj.services)) {
      const services = obj.services as Record<string, unknown>;
      for (const svc of Object.values(services)) {
        if (!svc || typeof svc !== 'object' || Array.isArray(svc)) {
          continue;
        }
        const service = svc as Record<string, unknown>;
        if (service.env && typeof service.env === 'object' && !Array.isArray(service.env)) {
          service.env = sanitizeEnvObject(service.env as Record<string, string>);
        }
      }
    }

    return JSON.stringify(obj, null, 2);
  } catch (error) {
    logError('appRegistry.sanitizeManifestForStorage', error);
    // Return empty manifest rather than unsanitized input that may contain secrets
    return '{}';
  }
}

/** Sanitize a single env object, replacing sensitive values with empty strings. */
function sanitizeEnvObject(env: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    sanitized[key] = SENSITIVE_ENV_PATTERN.test(key) ? '' : String(value);
  }
  return sanitized;
}

function storageKey(address: string): string {
  return `barney-apps-${address}`;
}

/**
 * Load apps from localStorage for a wallet address.
 * Returns empty array on corruption (clears bad data).
 */
function loadApps(address: string): AppEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(address));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      localStorage.removeItem(storageKey(address));
      return [];
    }
    // Sanitize: keep only entries that pass schema validation
    const valid = parsed
      .map((entry) => AppEntrySchema.safeParse(entry))
      .filter((r) => r.success)
      .map((r) => r.data);
    // If we dropped entries, persist the cleaned list
    if (valid.length !== parsed.length) {
      if (!saveApps(address, valid)) {
        logError('appRegistry.loadApps', new Error(`Failed to persist cleaned registry (dropped ${parsed.length - valid.length} invalid entries)`));
      }
    }
    return valid;
  } catch (error) {
    logError('appRegistry.loadApps', error);
    localStorage.removeItem(storageKey(address));
    return [];
  }
}

function saveApps(address: string, apps: AppEntry[]): boolean {
  try {
    localStorage.setItem(storageKey(address), JSON.stringify(apps));
    return true;
  } catch (error) {
    logError('appRegistry.saveApps', error);
    return false;
  }
}

/**
 * Validate an app name.
 * Returns null if valid, or an error string describing the issue.
 *
 * Names of stopped/failed apps can be reused — only running/deploying apps block a name.
 */
export function validateAppName(
  name: string,
  address: string,
  excludeLeaseUuid?: string
): string | null {
  if (!name) {
    return 'App name is required.';
  }
  if (name.length > 32) {
    return 'App name must be 32 characters or fewer.';
  }
  if (!APP_NAME_REGEX.test(name)) {
    return 'App name must be lowercase alphanumeric with hyphens, and cannot start or end with a hyphen.';
  }
  // Uniqueness check — only running/deploying apps block the name
  const apps = loadApps(address);
  const existing = apps.find(
    (a) =>
      a.name === name &&
      a.leaseUuid !== excludeLeaseUuid &&
      (a.status === 'running' || a.status === 'deploying')
  );
  if (existing) {
    return `An app named "${name}" is already ${existing.status}.`;
  }
  return null;
}

/** Get all apps for a wallet address. */
export function getApps(address: string): AppEntry[] {
  return loadApps(address);
}

/** Get a single app by exact name. Returns null if not found. */
export function getApp(address: string, name: string): AppEntry | null {
  return loadApps(address).find((a) => a.name === name) ?? null;
}

/**
 * Find an app by fuzzy name matching. Tries in order:
 * 1. Exact match
 * 2. Suffix match (e.g. "doom" matches "manifest-doom")
 * 3. Substring match (e.g. "doom" matches "my-doom-app")
 *
 * Only matches active apps (running/deploying) first; falls back to all apps.
 * Returns null if no match or if multiple apps match ambiguously.
 */
export function findApp(address: string, name: string): AppEntry | null {
  const apps = loadApps(address);
  const lower = name.toLowerCase();

  // Exact match (any status)
  const exact = apps.find((a) => a.name === lower);
  if (exact) return exact;

  // Prefer active apps for fuzzy matching
  const active = apps.filter((a) => a.status === 'running' || a.status === 'deploying');
  const pool = active.length > 0 ? active : apps;

  // Suffix match: app name ends with "-{input}" or equals input
  const suffixMatches = pool.filter((a) => a.name.endsWith(`-${lower}`));
  if (suffixMatches.length === 1) return suffixMatches[0];

  // Substring match
  const substringMatches = pool.filter((a) => a.name.includes(lower));
  if (substringMatches.length === 1) return substringMatches[0];

  return null;
}

/** Get a single app by lease UUID. Returns null if not found. */
export function getAppByLease(address: string, leaseUuid: string): AppEntry | null {
  return loadApps(address).find((a) => a.leaseUuid === leaseUuid) ?? null;
}

/**
 * Add a new app entry. Returns the added entry.
 * Removes any existing stopped/failed app with the same name (allows name reuse).
 * Throws if localStorage write fails (callers should surface this to the user).
 */
export function addApp(address: string, entry: AppEntry): AppEntry {
  let apps = loadApps(address);
  // Remove old stopped/failed entries with the same name
  apps = apps.filter(
    (a) =>
      a.name !== entry.name ||
      (a.status !== 'stopped' && a.status !== 'failed')
  );
  apps.push(entry);
  if (!saveApps(address, apps)) {
    throw new Error('Failed to save app to local registry (localStorage may be full). The lease was created on-chain but may not appear in the sidebar.');
  }
  return entry;
}

/** Update fields on an existing app (matched by leaseUuid). Returns updated entry or null. */
export function updateApp(
  address: string,
  leaseUuid: string,
  updates: Partial<Omit<AppEntry, 'leaseUuid'>>
): AppEntry | null {
  const apps = loadApps(address);
  const idx = apps.findIndex((a) => a.leaseUuid === leaseUuid);
  if (idx === -1) return null;

  apps[idx] = { ...apps[idx], ...updates };
  if (!saveApps(address, apps)) {
    logError('appRegistry.updateApp', new Error('localStorage write failed — update may not persist across page reload'));
  }
  return apps[idx];
}

/** Remove an app by lease UUID. Returns true if found and removed. */
export function removeApp(address: string, leaseUuid: string): boolean {
  const apps = loadApps(address);
  const filtered = apps.filter((a) => a.leaseUuid !== leaseUuid);
  if (filtered.length === apps.length) return false;
  if (!saveApps(address, filtered)) {
    logError('appRegistry.removeApp', new Error('localStorage write failed — removal may not persist across page reload'));
  }
  return true;
}

/**
 * Reconcile registry with on-chain state.
 * Marks apps as "stopped" if their lease is closed/expired/rejected on-chain.
 *
 * @param address - wallet address
 * @param activeLeaseUuids - set of lease UUIDs that are still active/pending on-chain
 */
export function reconcileWithChain(
  address: string,
  activeLeaseUuids: Set<string>
): void {
  const apps = loadApps(address);
  let changed = false;

  for (const app of apps) {
    if (
      (app.status === 'running' || app.status === 'deploying') &&
      !activeLeaseUuids.has(app.leaseUuid)
    ) {
      app.status = 'stopped';
      changed = true;
    } else if (
      app.status === 'failed' &&
      activeLeaseUuids.has(app.leaseUuid)
    ) {
      // Lease is still active on-chain — restore to running.
      // Covers false failures from transient issues (e.g. WebSocket/polling
      // errors during restart/update).
      app.status = 'running';
      changed = true;
    }
  }

  if (changed) {
    if (!saveApps(address, apps)) {
      logError('appRegistry.reconcileWithChain', new Error('localStorage write failed — reconciliation may not persist across page reload'));
    }
  }
}
