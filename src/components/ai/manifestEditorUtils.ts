/**
 * Pure utility functions for the ManifestEditor and ConfirmationCard.
 * Extracted to a separate file to satisfy react-refresh/only-export-components.
 */

import type { PendingAction } from '../../ai/toolExecutor';

export interface ManifestFields {
  image: string;
  ports: Record<string, Record<string, never>>;
  env: Record<string, string>;
  user?: string;
  tmpfs?: string[];
}

const EDITABLE_TOOL_NAMES = new Set(['deploy_app', 'update_app']);

/**
 * Parse an editable manifest from a pending action.
 * Returns non-null only for image-based deploys/updates (args._generatedManifest present).
 */
export function parseEditableManifest(action: PendingAction): ManifestFields | null {
  if (!EDITABLE_TOOL_NAMES.has(action.toolName)) return null;
  const json = action.args._generatedManifest;
  if (typeof json !== 'string') return null;

  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    // Stack manifests are not editable in v1 — shown as read-only summary
    if (parsed.services && typeof parsed.services === 'object' && !Array.isArray(parsed.services)) {
      return null;
    }
    return {
      image: (parsed.image as string) || '',
      ports: (parsed.ports as Record<string, Record<string, never>>) || {},
      env: (parsed.env as Record<string, string>) || {},
      user: (parsed.user as string) || undefined,
      tmpfs: Array.isArray(parsed.tmpfs) ? (parsed.tmpfs as string[]) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Serialize ManifestFields back to a JSON string, omitting empty optional sections.
 */
export function serializeManifest(manifest: ManifestFields): string {
  const obj: Record<string, unknown> = { image: manifest.image };
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
