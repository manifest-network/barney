/**
 * Pure utility functions for the ManifestEditor and ConfirmationCard.
 * Extracted to a separate file to satisfy react-refresh/only-export-components.
 */

import type { PendingAction } from '../../ai/toolExecutor';
import type { PortOptions } from '../../ai/manifest';
import { logError } from '../../utils/errors';
import { MANIFEST_NOTICE_KEY } from '../../config/constants';

export type { PortOptions };

/** Safely cast a parsed value to a record, defaulting to {} for non-objects. */
function safeRecord<T>(raw: unknown): Record<string, T> {
  return (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw as Record<string, T>
    : {};
}

/** Parse env vars, coercing non-string values to strings so the editor state always matches Record<string, string>. */
function safeEnv(raw: unknown): Record<string, string> {
  const record = safeRecord<unknown>(raw);
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'string') {
      result[k] = v;
    } else if (v !== null && typeof v === 'object') {
      try { result[k] = JSON.stringify(v); } catch { result[k] = String(v); }
    } else {
      result[k] = String(v ?? '');
    }
  }
  return result;
}

export interface ManifestFields {
  image: string;
  ports: Record<string, PortOptions>;
  env: Record<string, string>;
  /** Informational notice shown in the editor (not included in the deployed manifest). */
  notice?: string;
  user?: string;
  tmpfs?: string[];
  /** Non-editable fields preserved from the original manifest (command, args, health_check, etc.). */
  passthrough?: Record<string, unknown>;
}

export interface StackServiceFields {
  editable: ManifestFields;
  passthrough: Record<string, unknown>;
}

export type StackManifestFields = Record<string, StackServiceFields>;

const EDITABLE_TOOL_NAMES = new Set(['deploy_app', 'update_app']);

/** Keys that the editor handles (everything else is passthrough). */
const EDITABLE_KEYS = new Set(['image', 'ports', 'env', 'user', 'tmpfs']);

/** Additional keys excluded from passthrough for single-service manifests. */
const NOTICE_KEYS = new Set([MANIFEST_NOTICE_KEY]);

/** Extract editable ManifestFields from a raw parsed object. */
function extractEditableFields(raw: Record<string, unknown>): Omit<ManifestFields, 'notice' | 'passthrough'> {
  return {
    image: typeof raw.image === 'string' ? raw.image : '',
    ports: safeRecord<PortOptions>(raw.ports),
    env: safeEnv(raw.env),
    user: typeof raw.user === 'string' ? raw.user : undefined,
    tmpfs: Array.isArray(raw.tmpfs) ? raw.tmpfs.filter((v): v is string => typeof v === 'string') : undefined,
  };
}

/** Collect non-editable keys from a raw object into a passthrough record. */
function extractPassthrough(raw: Record<string, unknown>, extraKeys?: Set<string>): Record<string, unknown> {
  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!EDITABLE_KEYS.has(k) && !extraKeys?.has(k)) {
      passthrough[k] = v;
    }
  }
  return passthrough;
}

/** Write editable fields onto a target object, omitting empty optional sections. */
function writeEditableFields(target: Record<string, unknown>, fields: ManifestFields): void {
  target.image = fields.image;
  if (Object.keys(fields.ports).length > 0) target.ports = fields.ports;
  if (Object.keys(fields.env).length > 0) target.env = fields.env;
  if (fields.user) target.user = fields.user;
  if (fields.tmpfs && fields.tmpfs.length > 0) target.tmpfs = fields.tmpfs;
}

/**
 * Parse an editable manifest from a pending action.
 * Returns non-null only for image-based deploys/updates (args._generatedManifest present).
 */
export function parseEditableManifest(action: PendingAction): ManifestFields | null {
  if (!EDITABLE_TOOL_NAMES.has(action.toolName)) return null;
  const json = action.args._generatedManifest;
  if (typeof json !== 'string') return null;

  try {
    const parsed = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // Stack manifests are handled separately via parseEditableStackManifest
    if (parsed.services && typeof parsed.services === 'object' && !Array.isArray(parsed.services)) {
      return null;
    }
    const passthrough = extractPassthrough(parsed, NOTICE_KEYS);
    return {
      ...extractEditableFields(parsed),
      notice: typeof parsed[MANIFEST_NOTICE_KEY] === 'string' ? parsed[MANIFEST_NOTICE_KEY] : undefined,
      passthrough: Object.keys(passthrough).length > 0 ? passthrough : undefined,
    };
  } catch (err) {
    logError('parseEditableManifest', err);
    return null;
  }
}

/**
 * Serialize ManifestFields back to a JSON string, omitting empty optional sections.
 * Passthrough fields (command, args, health_check, etc.) are merged first so
 * editable fields always take precedence.
 */
export function serializeManifest(manifest: ManifestFields): string {
  const obj: Record<string, unknown> = { ...(manifest.passthrough ?? {}) };
  writeEditableFields(obj, manifest);
  return JSON.stringify(obj, null, 2);
}

/**
 * Validate a port number string. Accepts 1-65535, no leading zeros or decimals.
 */
export function isValidPort(value: string): boolean {
  const n = parseInt(value, 10);
  return !isNaN(n) && n >= 1 && n <= 65535 && String(n) === value;
}

/**
 * Parse a stack manifest from a pending action into per-service editable + passthrough fields.
 * Returns null for non-stack manifests or non-deploy/update actions.
 */
export function parseEditableStackManifest(action: PendingAction): StackManifestFields | null {
  if (!EDITABLE_TOOL_NAMES.has(action.toolName)) return null;
  const json = action.args._generatedManifest;
  if (typeof json !== 'string') return null;

  try {
    const parsed = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!parsed.services || typeof parsed.services !== 'object' || Array.isArray(parsed.services)) {
      return null;
    }
    const services = parsed.services as Record<string, Record<string, unknown>>;
    const result: StackManifestFields = {};
    for (const [name, svc] of Object.entries(services)) {
      if (!svc || typeof svc !== 'object') continue;
      result[name] = {
        editable: extractEditableFields(svc),
        passthrough: extractPassthrough(svc),
      };
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch (err) {
    logError('parseEditableStackManifest', err);
    return null;
  }
}

/**
 * Serialize a StackManifestFields back to a JSON string, merging editable fields with passthrough.
 */
export function serializeStackManifest(stack: StackManifestFields): string {
  const services: Record<string, Record<string, unknown>> = {};
  for (const [name, { editable, passthrough }] of Object.entries(stack)) {
    const svc: Record<string, unknown> = { ...passthrough };
    writeEditableFields(svc, editable);
    services[name] = svc;
  }
  return JSON.stringify({ services }, null, 2);
}
