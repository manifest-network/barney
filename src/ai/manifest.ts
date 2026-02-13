/**
 * Manifest builder for image-based deploys.
 * Builds a provider-compatible manifest JSON from a Docker image reference,
 * computes its SHA-256 hash, and returns a PayloadAttachment.
 */

import { sha256, toHex, generatePassword, validatePayloadSize } from '../utils/hash';
import { logError } from '../utils/errors';
import type { PayloadAttachment } from './toolExecutor/types';

/**
 * Derive an app name from a Docker image reference.
 * Strips registry prefix, tag, digest, and normalizes to valid app name chars.
 *
 * Examples:
 *   "redis:8.4"                        → "redis"
 *   "docker.io/library/redis:8.4"      → "redis"
 *   "ghcr.io/org/my-app:latest"        → "my-app"
 *   "postgres@sha256:abc..."            → "postgres"
 */
export function deriveAppNameFromImage(image: string): string {
  let name = image;

  // Strip tag (:...) or digest (@sha256:...)
  name = name.replace(/@sha256:[a-fA-F0-9]+$/, '');
  name = name.replace(/:[\w][\w.-]*$/, '');

  // Strip registry prefix (anything before the last slash)
  const lastSlash = name.lastIndexOf('/');
  if (lastSlash !== -1) {
    name = name.slice(lastSlash + 1);
  }

  // Strip "library/" prefix (Docker Hub official images)
  if (name.startsWith('library/')) {
    name = name.slice(8);
  }

  // Normalize: lowercase, replace invalid chars, collapse hyphens
  name = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);

  return name || 'app';
}

/**
 * Normalize a port specification into the manifest ports format.
 * Accepts comma-separated ports with optional protocol suffix.
 *
 * Examples:
 *   "6379"           → { "6379/tcp": {} }
 *   "6379,8080"      → { "6379/tcp": {}, "8080/tcp": {} }
 *   "53/udp"         → { "53/udp": {} }
 *   "8080/tcp,53/udp"→ { "8080/tcp": {}, "53/udp": {} }
 */
export function normalizePorts(port: string): Record<string, Record<string, never>> {
  const result: Record<string, Record<string, never>> = {};
  const VALID_PROTOCOLS = new Set(['tcp', 'udp']);

  for (const raw of port.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let portStr: string;
    let protocol: string;
    if (trimmed.includes('/')) {
      const slashIdx = trimmed.indexOf('/');
      portStr = trimmed.slice(0, slashIdx);
      protocol = trimmed.slice(slashIdx + 1);
    } else {
      portStr = trimmed;
      protocol = 'tcp';
    }

    const portNum = parseInt(portStr, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535 || String(portNum) !== portStr) {
      throw new Error(`Invalid port: "${portStr}". Port must be a number between 1 and 65535.`);
    }
    if (!VALID_PROTOCOLS.has(protocol)) {
      throw new Error(`Invalid protocol: "${protocol}". Must be "tcp" or "udp".`);
    }

    result[`${portNum}/${protocol}`] = {};
  }

  return result;
}

export interface BuildManifestResult {
  payload: PayloadAttachment;
  json: string;
  derivedAppName: string;
}

export interface BuildManifestOptions {
  image: string;
  port?: string;
  env?: Record<string, string>;
  user?: string;
  tmpfs?: string;
}

/**
 * Build a manifest JSON from Docker image parameters, compute its hash,
 * and return a PayloadAttachment ready for the deploy flow.
 *
 * Empty env values are replaced with auto-generated passwords.
 */
export async function buildManifest(opts: BuildManifestOptions): Promise<BuildManifestResult> {
  const manifest: Record<string, unknown> = {
    image: opts.image,
  };

  // Ports
  if (opts.port) {
    manifest.ports = normalizePorts(opts.port);
  }

  // Env — auto-generate passwords for empty values
  if (opts.env && Object.keys(opts.env).length > 0) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(opts.env)) {
      env[key] = value === '' ? generatePassword() : value.endsWith('/') ? value + generatePassword() : value;
    }
    manifest.env = env;
  }

  // User
  if (opts.user) {
    manifest.user = opts.user;
  }

  // Tmpfs
  if (opts.tmpfs) {
    const paths = opts.tmpfs.split(',').map((p) => p.trim()).filter(Boolean);
    if (paths.length > 0) {
      manifest.tmpfs = paths;
    }
  }

  const json = JSON.stringify(manifest, null, 2);

  if (!validatePayloadSize(json)) {
    throw new Error('Generated manifest exceeds maximum payload size (5KB)');
  }

  const bytes = new TextEncoder().encode(json);
  const hash = toHex(await sha256(json));
  const derivedAppName = deriveAppNameFromImage(opts.image);

  return {
    payload: {
      bytes,
      filename: `${derivedAppName}.json`,
      size: bytes.length,
      hash,
    },
    json,
    derivedAppName,
  };
}

/**
 * Merge old manifest fields as defaults into a new manifest.
 * Preserves env vars, ports, user, and tmpfs from the old manifest
 * unless the new manifest explicitly overrides them.
 *
 * - env: old vars carry forward; new values override
 * - ports: old ports carry forward; new ports override
 * - user: old value used if new manifest doesn't specify one
 * - tmpfs: old value used if new manifest doesn't specify one
 * - image: always from new manifest
 */
export function mergeManifest(
  newManifest: Record<string, unknown>,
  oldManifestJson: string
): Record<string, unknown> {
  let oldManifest: Record<string, unknown>;
  try {
    oldManifest = JSON.parse(oldManifestJson);
    if (typeof oldManifest !== 'object' || oldManifest === null || Array.isArray(oldManifest)) {
      return newManifest;
    }
  } catch (error) {
    logError('manifest.mergeManifest.parseOld', error);
    return newManifest;
  }

  const merged = { ...newManifest };

  // env: old vars carry forward, new values override
  const oldEnv = oldManifest.env;
  const newEnv = newManifest.env;
  if (oldEnv && typeof oldEnv === 'object' && !Array.isArray(oldEnv)) {
    merged.env = { ...(oldEnv as Record<string, string>), ...(newEnv as Record<string, string> | undefined) };
  }

  // ports: old ports carry forward, new ports override
  const oldPorts = oldManifest.ports;
  const newPorts = newManifest.ports;
  if (oldPorts && typeof oldPorts === 'object' && !Array.isArray(oldPorts)) {
    merged.ports = { ...(oldPorts as Record<string, unknown>), ...(newPorts as Record<string, unknown> | undefined) };
  }

  // user: old value used if new manifest doesn't specify one
  if (newManifest.user === undefined && oldManifest.user !== undefined) {
    merged.user = oldManifest.user;
  }

  // tmpfs: old value used if new manifest doesn't specify one
  if (newManifest.tmpfs === undefined && oldManifest.tmpfs !== undefined) {
    merged.tmpfs = oldManifest.tmpfs;
  }

  return merged;
}
