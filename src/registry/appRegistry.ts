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

/** Chain observation. `'absent'` = we looked and it was gone; an OBSERVATION, not an intent. */
export const CHAIN_STATES = ['active', 'pending', 'absent'] as const;
export type ChainState = (typeof CHAIN_STATES)[number];

/**
 * Provider provisioning observation. `'unconfirmed'` is the honest middle value:
 * accepted, but no readiness verdict ever arrived. NOT "failed", NOT "running".
 */
export const PROVISION_STATES = ['confirmed', 'unconfirmed', 'failed'] as const;
export type ProvisionState = (typeof PROVISION_STATES)[number];

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
    instances: z.array(z.object({ fqdn: z.string().optional(), ports: z.record(z.string(), z.unknown()).optional() }).passthrough()).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    services: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  /** DERIVED from the two observations below; a passed-in `status` is only rule 5's fallback. */
  status: z.enum(APP_STATUSES),
  /** Chain observation. ABSENT (undefined) = never observed, which is what every pre-existing entry is. */
  chainState: z.enum(CHAIN_STATES).optional(),
  /** ABSENT (undefined) = never observed; a writer without one (abort/cancel,
   *  UPDATE_INDETERMINATE) MUST leave it alone rather than invent a value. */
  provisionState: z.enum(PROVISION_STATES).optional(),
  manifest: z.string().optional(),
  /** Cached chain state for the lease's `LeaseItem.custom_domain` fields.
   *  Written by `executeConfirmedDeployApp` on successful attach and refreshed by
   *  `executeAppStatus` on every status check. Survives across page refreshes
   *  via localStorage; the polling driver in MainLayout uses it to know which
   *  apps to monitor without an extra chain round-trip per render. */
  customDomains: z.array(z.object({
    serviceName: z.string(),
    customDomain: z.string(),
  })).optional(),
});

export type AppEntry = z.infer<typeof AppEntrySchema>;

/** The observation fields plus the legacy `status` that rule 5 falls back to. */
export type AppStatusInputs = Pick<AppEntry, 'chainState' | 'provisionState' | 'status'>;

/**
 * Derive the `status` summary from the two independent observations. Writers
 * record only what they saw, so a chain tick can no longer revert the provider's
 * `failed` verdict to `running`. Precedence is by AUTHORITY, not recency:
 *  1. `provisionState 'failed'` → `'failed'` (outranks chain-absent: both are
 *     terminal, and `failed` is the more informative).
 *  2. `chainState 'absent'` → `'stopped'`, unless there is no provider
 *     observation and the legacy `status` is `'failed'`, which is kept.
 *  3. `provisionState 'unconfirmed'` → `'deploying'`.
 *  4. `provisionState 'confirmed'` → `'deploying'` while chain-`pending`, else `'running'`.
 *  5. Otherwise chain-only: `active` → `'running'`, `pending` → `'deploying'`,
 *     nothing observed → the stored legacy `status`.
 *
 * Rule 2 MUST stay ahead of rule 3: `'deploying'` is the only NON-terminal label
 * (it spins, and blocks name reuse), so a stopped app whose deploy ended
 * `unconfirmed` would spin forever with its name taken.
 */
export function deriveAppStatus(e: AppStatusInputs): AppStatus {
  if (e.provisionState === 'failed') return 'failed';

  if (e.chainState === 'absent') {
    // Legacy carve-out: with no provider observation, `status` is the only
    // surviving record of a failure, and chain-absence says nothing about why.
    return e.provisionState === undefined && e.status === 'failed' ? 'failed' : 'stopped';
  }

  if (e.provisionState === 'unconfirmed') return 'deploying';

  if (e.provisionState === 'confirmed') {
    return e.chainState === 'pending' ? 'deploying' : 'running';
  }

  if (e.chainState === 'active') return 'running';
  if (e.chainState === 'pending') return 'deploying';
  return e.status;
}

/** Name validation: lowercase alphanumeric + hyphens, 1-32 chars, no leading/trailing hyphen */
const APP_NAME_REGEX = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/** Pattern matching env var names that likely contain secrets */
const SENSITIVE_ENV_PATTERN = /password|secret|token|key|credential|api[_-]?key/i;

/**
 * Value shaped like a URI with embedded credentials: scheme://[user]:pass@host.
 * The username is optional (`*`, not `+`) so the passwordless-userinfo form
 * `scheme://:pass@host` (e.g. `redis://:pw@host`) is also caught.
 */
const URL_USERINFO_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i;

/** True when the VALUE itself looks like a secret even if the key does not match. */
function valueLooksSensitive(value: string): boolean {
  return URL_USERINFO_PATTERN.test(value);
}

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
    const str = String(value);
    sanitized[key] = SENSITIVE_ENV_PATTERN.test(key) || valueLooksSensitive(str) ? '' : str;
  }
  return sanitized;
}

function storageKey(address: string): string {
  return `barney-apps-${address}`;
}

/**
 * In-tab change notifications.
 *
 * Mid-tool-execution writes (`executeAppStatus` updating customDomains,
 * `executeConfirmedDeployApp` flipping status) used to be invisible to the
 * sidebar until its 60s AUTO_REFRESH_INTERVAL_MS tick. Subscribing to this
 * pub/sub closes that gap.
 *
 * Only fires for the wallet whose registry was mutated, so a stale subscriber
 * from a previous wallet (cross-wallet switch race) doesn't get spurious
 * updates. localStorage 'storage' events handle the cross-tab case separately.
 */
type RegistryListener = (address: string) => void;
const listeners = new Set<RegistryListener>();

export function subscribeToRegistry(listener: RegistryListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(address: string): void {
  for (const listener of listeners) {
    try {
      listener(address);
    } catch (error) {
      logError('appRegistry.notify', error);
    }
  }
}

/**
 * Cross-tab synchronization via the localStorage `storage` event.
 *
 * Fires only in OTHER tabs (not the one that wrote), so this composes
 * cleanly with the in-tab `notify` path: a deploy in Tab A notifies via
 * the in-tab Set AND fires a `storage` event that Tab B picks up here.
 *
 * Filter on the `barney-apps-` prefix so foreign keys (`barney-ai-*`,
 * unrelated app keys) don't spuriously notify. Extract the address from
 * the key and route through `notify(address)` — subscribers already
 * filter by their own address (`mutated === address`), so cross-wallet
 * traffic from another tab on a different wallet is harmless.
 *
 * `newValue === null` (the other tab cleared its registry / disconnected)
 * is intentionally NOT special-cased: subscribers re-read via `getApps`,
 * which returns `[]` on missing key. The notify-then-reread pattern stays
 * uniform.
 *
 * `event.key === null` (devtools `localStorage.clear()`) is skipped — no
 * address info to route with, and subscribers will re-read on their next
 * interaction anyway.
 */
const STORAGE_KEY_PREFIX = 'barney-apps-';

function handleStorageEvent(event: StorageEvent): void {
  if (event.storageArea !== null && event.storageArea !== localStorage) return;
  const key = event.key;
  if (key === null) return;
  if (!key.startsWith(STORAGE_KEY_PREFIX)) return;
  const address = key.slice(STORAGE_KEY_PREFIX.length);
  if (!address) return;
  notify(address);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', handleStorageEvent);
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
 * Find an app by fuzzy name matching. Precedence:
 * 1. Active (running/deploying) exact match
 * 2. Active suffix match (e.g. "doom" matches "manifest-doom") — unique only
 * 3. Active substring match (e.g. "doom" matches "my-doom-app") — unique only
 * 4. If multiple active suffix/substring matches exist (ambiguous), return null
 *    to avoid falling back to a stopped app that shadows active ones
 * 5. Any-status exact match
 * 6. Any-status suffix match — unique only
 * 7. Any-status substring match — unique only
 *
 * Steps 5-7 only execute when no active fuzzy matches exist at all.
 * Returns null if no match or if multiple apps match ambiguously.
 */
export function findApp(address: string, name: string): AppEntry | null {
  const apps = loadApps(address);
  const lower = name.toLowerCase();
  const active = apps.filter((a) => a.status === 'running' || a.status === 'deploying');

  // Exact match — active first, then any status
  const activeExact = active.find((a) => a.name === lower);
  if (activeExact) return activeExact;

  // Active suffix match
  const activeSuffix = active.filter((a) => a.name.endsWith(`-${lower}`));
  if (activeSuffix.length === 1) return activeSuffix[0];

  // Active substring match
  const activeSubstring = active.filter((a) => a.name.includes(lower));
  if (activeSubstring.length === 1) return activeSubstring[0];

  // If active fuzzy matches exist but are ambiguous, return null
  // to avoid returning a stopped app that shadows active ones
  if (activeSuffix.length > 1 || activeSubstring.length > 1) return null;

  // Fall back to all apps (any status) — only when no active matches exist
  const anyExact = apps.find((a) => a.name === lower);
  if (anyExact) return anyExact;

  const anySuffix = apps.filter((a) => a.name.endsWith(`-${lower}`));
  if (anySuffix.length === 1) return anySuffix[0];

  const anySubstring = apps.filter((a) => a.name.includes(lower));
  if (anySubstring.length === 1) return anySubstring[0];

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
  // Derived, never taken on trust: with no observations it is rule 5's verbatim fallback.
  const stored: AppEntry = { ...entry, status: deriveAppStatus(entry) };
  // Remove old stopped/failed entries with the same name
  apps = apps.filter(
    (a) =>
      a.name !== stored.name ||
      (a.status !== 'stopped' && a.status !== 'failed')
  );
  apps.push(stored);
  if (!saveApps(address, apps)) {
    throw new Error('Failed to save app to local registry (localStorage may be full). The lease was created on-chain but may not appear in the sidebar.');
  }
  notify(address);
  return stored;
}

/**
 * Fields whose only repeatable writer (`executeAppStatus`) rebuilds the value
 * from scratch each call, so reference equality can never report "unchanged".
 * The notify, not the write, is the expensive half: `useDnsStatusPolling` keys
 * off the registry array's identity and aborts every in-flight DoH/HTTPS probe
 * when it changes — cancelling the probe the user re-ran `app_status` to check.
 */
const STRUCTURAL_FIELDS = new Set<string>(['customDomains', 'connection']);

/**
 * Structural equality for a `STRUCTURAL_FIELDS` value.
 *
 * TRAP: do NOT simplify to a raw `JSON.stringify(a) === JSON.stringify(b)`.
 * `prev` came back through `AppEntrySchema`, `next` is raw from the provider,
 * and zod both REORDERS keys into schema order and STRIPS ones it does not
 * model, so the two never match:
 *   fred wire : host, fqdn, ports, instances, services, protocol, metadata
 *   stored    : host, fqdn, ports, instances, metadata, services
 * A raw compare is false FOREVER, which made this dead code and had `app_status`
 * notify on every call. Parsing both sides through the same schema field
 * normalizes them identically; re-parsing the parsed `prev` is idempotent. JSON
 * rather than a hand-written walk because `connection` carries open bags this
 * module does not model; any uncertainty resolves to "changed".
 */
function sameStructurally(field: keyof AppEntry, a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  const shape = (AppEntrySchema.shape as Record<string, z.ZodTypeAny | undefined>)[field];
  if (!shape) return false;
  try {
    const na = shape.safeParse(a);
    const nb = shape.safeParse(b);
    if (!na.success || !nb.success) return false;
    return JSON.stringify(na.data) === JSON.stringify(nb.data);
  } catch {
    return false;
  }
}

/**
 * Fields no subscriber renders — they reach the UI only via the derived `status`,
 * so a write touching just these persists without notifying. A DENY-list on
 * purpose: a field added later defaults to NOTIFYING, so silence must be opted
 * into by someone who has checked the subscribers.
 */
const OBSERVATION_ONLY_FIELDS = new Set<string>(['chainState', 'provisionState']);

/**
 * Update fields on an existing app (matched by leaseUuid). Returns updated entry or null.
 *
 * `status` is re-derived from the MERGED entry, so an observation outranks an
 * asserted `status`. Fields absent from `updates` stay untouched — a writer with
 * no provisioning observation omits `provisionState` rather than invent one.
 *
 * Persist-vs-notify (`reconcileWithChain` uses the same split): `dirty` decides
 * whether to SAVE, `visible` whether to NOTIFY. Without it a writer on the 15s
 * refresh tick could only latch `chainState: 'absent'` and never refresh it back,
 * since re-asserting `'active'` would re-render the whole sidebar. "Changed"
 * means VALUE-changed, not reference-changed; see `STRUCTURAL_FIELDS`.
 */
export function updateApp(
  address: string,
  leaseUuid: string,
  updates: Partial<Omit<AppEntry, 'leaseUuid'>>
): AppEntry | null {
  const apps = loadApps(address);
  const idx = apps.findIndex((a) => a.leaseUuid === leaseUuid);
  if (idx === -1) return null;

  const prev = apps[idx];
  const merged = { ...prev, ...updates };
  const next: AppEntry = { ...merged, status: deriveAppStatus(merged) };
  apps[idx] = next;

  // A moved summary is always both persist- and notify-worthy, asked for or not.
  let visible = prev.status !== next.status;
  let dirty = visible;
  // Compare VALUES, not key presence: re-asserting a stored value is a no-op.
  for (const key of Object.keys(updates) as (keyof AppEntry)[]) {
    const unchanged = STRUCTURAL_FIELDS.has(key)
      ? sameStructurally(key, prev[key], next[key])
      : Object.is(prev[key], next[key]);
    if (unchanged) continue;
    dirty = true;
    if (!OBSERVATION_ONLY_FIELDS.has(key)) visible = true;
  }

  // Nothing moved — no write, no notify: re-observing is free in steady state.
  if (!dirty) return next;

  if (!saveApps(address, apps)) {
    logError('appRegistry.updateApp', new Error('localStorage write failed — update may not persist across page reload'));
    // Don't notify on save failure: subscribers re-read from localStorage and
    // would see stale state, masking the failure with a no-op refresh.
    return next;
  }
  if (visible) notify(address);
  return next;
}

/** Remove an app by lease UUID. Returns true if found and removed. */
export function removeApp(address: string, leaseUuid: string): boolean {
  const apps = loadApps(address);
  const filtered = apps.filter((a) => a.leaseUuid !== leaseUuid);
  if (filtered.length === apps.length) return false;
  if (!saveApps(address, filtered)) {
    logError('appRegistry.removeApp', new Error('localStorage write failed — removal may not persist across page reload'));
    // See updateApp note: skip notify on save failure to avoid stale-read masking.
    return true;
  }
  notify(address);
  return true;
}

/**
 * Reconcile registry with on-chain state.
 *
 * Observes exactly ONE thing — the chain — so it writes exactly one field:
 * `chainState`. Deliberately NO status-promotion branch: chain-ACTIVE alone used
 * to promote `failed`/`deploying` → `running`, reverting the provider's verdict
 * on the next tick. `deriveAppStatus` owns the summary now.
 *
 * @param address - wallet address
 * @param leaseStates - map of lease UUID → 'active' | 'pending' for leases still on-chain
 */
export function reconcileWithChain(
  address: string,
  leaseStates: Map<string, 'active' | 'pending'>
): void {
  const apps = loadApps(address);
  // `dirty` persists a fresh observation even when the summary is unchanged;
  // `statusChanged` gates the notify (see updateApp's persist-vs-notify note).
  let dirty = false;
  let statusChanged = false;

  for (const app of apps) {
    // A lease missing from the tenant's live set was OBSERVED to be gone.
    const chainState: ChainState = leaseStates.get(app.leaseUuid) ?? 'absent';
    const status = deriveAppStatus({ ...app, chainState });

    if (app.chainState !== chainState) {
      app.chainState = chainState;
      dirty = true;
    }
    if (app.status !== status) {
      app.status = status;
      dirty = true;
      statusChanged = true;
    }
  }

  if (dirty) {
    if (!saveApps(address, apps)) {
      logError('appRegistry.reconcileWithChain', new Error('localStorage write failed — reconciliation may not persist across page reload'));
      // See updateApp note: skip notify on save failure to avoid stale-read masking.
      return;
    }
    if (statusChanged) notify(address);
  }
}
