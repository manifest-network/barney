/**
 * App Registry — localStorage-backed name→lease mapping, scoped per wallet address.
 *
 * Provides a friendly "app name" layer on top of raw lease UUIDs. Each wallet
 * address gets its own isolated registry keyed as `barney-apps-{address}`.
 */

import { logError } from '../utils/errors';

export type AppStatus = 'deploying' | 'running' | 'stopped' | 'failed';

export interface AppEntry {
  name: string;
  leaseUuid: string;
  size: string;
  providerUuid: string;
  providerUrl: string;
  createdAt: number;
  url?: string;
  connection?: { host: string; ports?: Record<string, { host_ip: string; host_port: number }> };
  status: AppStatus;
}

/** Name validation: lowercase alphanumeric + hyphens, 1-32 chars, no leading/trailing hyphen */
const APP_NAME_REGEX = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

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
    // Sanitize: keep only entries with required fields
    const valid = parsed.filter(
      (entry): entry is AppEntry =>
        entry != null &&
        typeof entry === 'object' &&
        typeof (entry as AppEntry).name === 'string' &&
        typeof (entry as AppEntry).leaseUuid === 'string' &&
        typeof (entry as AppEntry).size === 'string' &&
        typeof (entry as AppEntry).providerUuid === 'string' &&
        typeof (entry as AppEntry).providerUrl === 'string' &&
        typeof (entry as AppEntry).createdAt === 'number' &&
        typeof (entry as AppEntry).status === 'string'
    );
    // If we dropped entries, persist the cleaned list
    if (valid.length !== parsed.length) {
      saveApps(address, valid);
    }
    return valid;
  } catch (error) {
    logError('appRegistry.loadApps', error);
    localStorage.removeItem(storageKey(address));
    return [];
  }
}

function saveApps(address: string, apps: AppEntry[]): void {
  try {
    localStorage.setItem(storageKey(address), JSON.stringify(apps));
  } catch (error) {
    logError('appRegistry.saveApps', error);
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

/** Get a single app by name. Returns null if not found. */
export function getApp(address: string, name: string): AppEntry | null {
  return loadApps(address).find((a) => a.name === name) ?? null;
}

/** Get a single app by lease UUID. Returns null if not found. */
export function getAppByLease(address: string, leaseUuid: string): AppEntry | null {
  return loadApps(address).find((a) => a.leaseUuid === leaseUuid) ?? null;
}

/**
 * Add a new app entry. Returns the added entry.
 * Removes any existing stopped/failed app with the same name (allows name reuse).
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
  saveApps(address, apps);
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
  saveApps(address, apps);
  return apps[idx];
}

/** Remove an app by lease UUID. Returns true if found and removed. */
export function removeApp(address: string, leaseUuid: string): boolean {
  const apps = loadApps(address);
  const filtered = apps.filter((a) => a.leaseUuid !== leaseUuid);
  if (filtered.length === apps.length) return false;
  saveApps(address, filtered);
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
    }
  }

  if (changed) {
    saveApps(address, apps);
  }
}
