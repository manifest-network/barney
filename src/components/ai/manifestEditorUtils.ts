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

/** Keys that both single-service and stack editors handle (everything else is passthrough). */
const EDITABLE_BASE_KEYS = new Set(['image', 'ports', 'env', 'user', 'tmpfs']);

/** Single-service also handles the notice key (top-level only, not per-service). */
const EDITABLE_SINGLE_KEYS = new Set([...EDITABLE_BASE_KEYS, MANIFEST_NOTICE_KEY]);

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
    const passthrough: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!EDITABLE_SINGLE_KEYS.has(k)) {
        passthrough[k] = v;
      }
    }
    return {
      image: (parsed.image as string) || '',
      ports: safeRecord<PortOptions>(parsed.ports),
      env: safeRecord<string>(parsed.env),
      notice: typeof parsed[MANIFEST_NOTICE_KEY] === 'string' ? (parsed[MANIFEST_NOTICE_KEY] as string) : undefined,
      user: (parsed.user as string) || undefined,
      tmpfs: Array.isArray(parsed.tmpfs) ? (parsed.tmpfs as string[]) : undefined,
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
  const obj: Record<string, unknown> = { ...(manifest.passthrough || {}) };
  obj.image = manifest.image;
  if (Object.keys(manifest.ports).length > 0) obj.ports = manifest.ports;
  if (Object.keys(manifest.env).length > 0) obj.env = manifest.env;
  if (manifest.user) obj.user = manifest.user;
  if (manifest.tmpfs && manifest.tmpfs.length > 0) obj.tmpfs = manifest.tmpfs;
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
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed.services || typeof parsed.services !== 'object' || Array.isArray(parsed.services)) {
      return null;
    }
    const services = parsed.services as Record<string, Record<string, unknown>>;
    const result: StackManifestFields = {};
    for (const [name, svc] of Object.entries(services)) {
      if (!svc || typeof svc !== 'object') continue;
      const passthrough: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(svc)) {
        if (!EDITABLE_BASE_KEYS.has(k)) {
          passthrough[k] = v;
        }
      }
      result[name] = {
        editable: {
          image: (svc.image as string) || '',
          ports: safeRecord<PortOptions>(svc.ports),
          env: safeRecord<string>(svc.env),
          user: (svc.user as string) || undefined,
          tmpfs: Array.isArray(svc.tmpfs) ? (svc.tmpfs as string[]) : undefined,
        },
        passthrough,
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
    // Spread passthrough first so editable fields always take precedence
    const svc: Record<string, unknown> = { ...passthrough };
    svc.image = editable.image;
    if (Object.keys(editable.ports).length > 0) svc.ports = editable.ports;
    if (Object.keys(editable.env).length > 0) svc.env = editable.env;
    if (editable.user) svc.user = editable.user;
    if (editable.tmpfs && editable.tmpfs.length > 0) svc.tmpfs = editable.tmpfs;
    services[name] = svc;
  }
  return JSON.stringify({ services }, null, 2);
}
