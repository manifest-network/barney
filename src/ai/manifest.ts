/**
 * Manifest builder for image-based deploys.
 * Builds a provider-compatible manifest JSON from a Docker image reference,
 * computes its SHA-256 hash, and returns a PayloadAttachment.
 *
 * Supports both single-service and stack (multi-service) manifests.
 * Stack manifests use the `{ "services": { ... } }` format, where each
 * service is a named container with its own image, ports, env, etc.
 */

import { sha256, toHex, generatePassword, validatePayloadSize } from '../utils/hash';
import { logError } from '../utils/errors';
import { MAX_APP_NAME_LENGTH } from '../registry/appRegistry';
import type { PayloadAttachment } from './toolExecutor/types';

/**
 * Derive an app name from a Docker image reference.
 * Strips registry prefix and digest; includes meaningful tags (not "latest").
 * Normalizes to valid app name chars (lowercase alphanumeric + hyphens, up to MAX_APP_NAME_LENGTH).
 *
 * Examples:
 *   "redis:8.4"                        → "redis-8-4"
 *   "docker.io/library/redis:8.4"      → "redis-8-4"
 *   "ghcr.io/org/my-app:latest"        → "my-app"
 *   "postgres@sha256:abc..."            → "postgres"
 *   "node:20-alpine"                   → "node-20-alpine"
 */
export function deriveAppNameFromImage(image: string): string {
  let name = image;

  // Strip digest (@sha256:...)
  name = name.replace(/@sha256:[a-fA-F0-9]+$/, '');

  // Extract and preserve meaningful tags (not "latest")
  let tag = '';
  const tagMatch = name.match(/:(?<tag>[\w][\w.-]*)$/);
  if (tagMatch?.groups?.tag && tagMatch.groups.tag !== 'latest') {
    tag = tagMatch.groups.tag;
  }
  name = name.replace(/:[\w][\w.-]*$/, '');

  // Strip registry prefix / org path (anything before the last slash).
  // This also handles Docker Hub official images (docker.io/library/redis → redis).
  const lastSlash = name.lastIndexOf('/');
  if (lastSlash !== -1) {
    name = name.slice(lastSlash + 1);
  }

  // Append tag if present
  if (tag) {
    name = `${name}-${tag}`;
  }

  // Normalize: lowercase, replace invalid chars, collapse hyphens
  name = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_APP_NAME_LENGTH)
    .replace(/-+$/, '');

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

export interface HealthCheckConfig {
  test: string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  start_period?: string;
}

export interface BuildManifestOptions {
  image: string;
  port?: string;
  env?: Record<string, string>;
  user?: string;
  tmpfs?: string;
  command?: string[];
  args?: string[];
  health_check?: HealthCheckConfig;
  stop_grace_period?: string;
  init?: boolean;
  expose?: string;
  labels?: Record<string, string>;
  depends_on?: Record<string, { condition: string }>;
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

  // Command (entrypoint override)
  if (opts.command && opts.command.length > 0) {
    manifest.command = opts.command;
  }

  // Args (CMD override)
  if (opts.args && opts.args.length > 0) {
    manifest.args = opts.args;
  }

  // Health check
  if (opts.health_check) {
    manifest.health_check = opts.health_check;
  }

  // Stop grace period
  if (opts.stop_grace_period) {
    manifest.stop_grace_period = opts.stop_grace_period;
  }

  // Init (tini as PID 1)
  if (opts.init !== undefined) {
    manifest.init = opts.init;
  }

  // Expose (inter-service ports)
  if (opts.expose) {
    const ports = opts.expose.split(',').map((p) => p.trim()).filter(Boolean);
    if (ports.length > 0) {
      manifest.expose = ports;
    }
  }

  // Labels
  if (opts.labels && Object.keys(opts.labels).length > 0) {
    manifest.labels = opts.labels;
  }

  // Depends-on (service startup ordering)
  if (opts.depends_on && Object.keys(opts.depends_on).length > 0) {
    manifest.depends_on = opts.depends_on;
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
 * Single-service manifests only (stack updates use full manifest replacement).
 *
 * - env: old vars carry forward; new values override
 * - ports: old ports carry forward; new ports override
 * - labels: old labels carry forward; new labels override
 * - user: old value used if new manifest doesn't specify one
 * - tmpfs: old value used if new manifest doesn't specify one
 * - command: old value used if new manifest doesn't specify one
 * - args: old value used if new manifest doesn't specify one
 * - health_check: old value used if new manifest doesn't specify one
 * - stop_grace_period: old value used if new manifest doesn't specify one
 * - init: old value used if new manifest doesn't specify one
 * - expose: old value used if new manifest doesn't specify one
 * - depends_on: old value used if new manifest doesn't specify one
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

  // command: old value used if new manifest doesn't specify one
  if (newManifest.command === undefined && oldManifest.command !== undefined) {
    merged.command = oldManifest.command;
  }

  // args: old value used if new manifest doesn't specify one
  if (newManifest.args === undefined && oldManifest.args !== undefined) {
    merged.args = oldManifest.args;
  }

  // health_check: old value used if new manifest doesn't specify one
  if (newManifest.health_check === undefined && oldManifest.health_check !== undefined) {
    merged.health_check = oldManifest.health_check;
  }

  // stop_grace_period: old value used if new manifest doesn't specify one
  if (newManifest.stop_grace_period === undefined && oldManifest.stop_grace_period !== undefined) {
    merged.stop_grace_period = oldManifest.stop_grace_period;
  }

  // init: old value used if new manifest doesn't specify one
  if (newManifest.init === undefined && oldManifest.init !== undefined) {
    merged.init = oldManifest.init;
  }

  // expose: old value used if new manifest doesn't specify one
  if (newManifest.expose === undefined && oldManifest.expose !== undefined) {
    merged.expose = oldManifest.expose;
  }

  // labels: old labels carry forward, new labels override
  const oldLabels = oldManifest.labels;
  const newLabels = newManifest.labels;
  if (oldLabels && typeof oldLabels === 'object' && !Array.isArray(oldLabels)) {
    merged.labels = { ...(oldLabels as Record<string, string>), ...(newLabels as Record<string, string> | undefined) };
  }

  // depends_on: old value used if new manifest doesn't specify one
  if (newManifest.depends_on === undefined && oldManifest.depends_on !== undefined) {
    merged.depends_on = oldManifest.depends_on;
  }

  return merged;
}

// ============================================================================
// Stack (multi-service) manifests
// ============================================================================

/**
 * Configuration for a single service within a stack.
 * Identical to BuildManifestOptions — shared type to avoid duplication.
 */
export type ServiceConfig = BuildManifestOptions;

export interface StackManifestOptions {
  services: Record<string, ServiceConfig>;
}

/**
 * RFC 1123 DNS label validation for service names.
 * 1-63 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen.
 * Returns null if valid, or an error string describing the issue.
 */
export function validateServiceName(name: string): string | null {
  if (!name) return 'Service name is required.';
  if (name.length > 63) return 'Service name must be 63 characters or fewer.';
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    return 'Service name must be a valid DNS label: lowercase alphanumeric with hyphens, no leading/trailing hyphen.';
  }
  return null;
}

/**
 * Build a single service manifest object (used internally by buildStackManifest).
 * Auto-generates passwords for empty env values, same as buildManifest.
 */
function buildServiceManifestObject(cfg: ServiceConfig): Record<string, unknown> {
  const svc: Record<string, unknown> = { image: cfg.image };

  if (cfg.port) {
    svc.ports = normalizePorts(cfg.port);
  }

  if (cfg.env && Object.keys(cfg.env).length > 0) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(cfg.env)) {
      env[key] = value === '' ? generatePassword() : value.endsWith('/') ? value + generatePassword() : value;
    }
    svc.env = env;
  }

  if (cfg.user) svc.user = cfg.user;
  if (cfg.tmpfs) {
    const paths = cfg.tmpfs.split(',').map((p) => p.trim()).filter(Boolean);
    if (paths.length > 0) svc.tmpfs = paths;
  }
  if (cfg.command && cfg.command.length > 0) svc.command = cfg.command;
  if (cfg.args && cfg.args.length > 0) svc.args = cfg.args;
  if (cfg.health_check) svc.health_check = cfg.health_check;
  if (cfg.stop_grace_period) svc.stop_grace_period = cfg.stop_grace_period;
  if (cfg.init !== undefined) svc.init = cfg.init;
  if (cfg.expose) {
    const ports = cfg.expose.split(',').map((p) => p.trim()).filter(Boolean);
    if (ports.length > 0) svc.expose = ports;
  }
  if (cfg.labels && Object.keys(cfg.labels).length > 0) svc.labels = cfg.labels;
  if (cfg.depends_on && Object.keys(cfg.depends_on).length > 0) svc.depends_on = cfg.depends_on;

  return svc;
}

/**
 * Build a stack manifest JSON from multiple service configs, compute its hash,
 * and return a PayloadAttachment ready for the deploy flow.
 *
 * The resulting manifest format: `{ "services": { "web": {...}, "db": {...} } }`
 */
export async function buildStackManifest(opts: StackManifestOptions): Promise<BuildManifestResult> {
  const serviceNames = Object.keys(opts.services);
  if (serviceNames.length === 0) {
    throw new Error('Stack manifest requires at least one service.');
  }

  // Validate all service names
  for (const name of serviceNames) {
    const error = validateServiceName(name);
    if (error) throw new Error(`Invalid service name "${name}": ${error}`);
  }

  const services: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(opts.services)) {
    services[name] = buildServiceManifestObject(cfg);
  }

  const manifest = { services };
  const json = JSON.stringify(manifest, null, 2);

  if (!validatePayloadSize(json)) {
    throw new Error('Generated stack manifest exceeds maximum payload size (5KB)');
  }

  const bytes = new TextEncoder().encode(json);
  const hash = toHex(await sha256(json));

  // Derive app name from the first service's image
  const firstService = opts.services[serviceNames[0]];
  const derivedAppName = deriveAppNameFromImage(firstService.image);

  return {
    payload: {
      bytes,
      filename: `${derivedAppName}-stack.json`,
      size: bytes.length,
      hash,
    },
    json,
    derivedAppName,
  };
}

/**
 * Check if a manifest is a stack manifest (has `services` key with object value).
 */
export function isStackManifest(manifest: unknown): boolean {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return false;
  }
  const obj = manifest as Record<string, unknown>;
  return (
    typeof obj.services === 'object' &&
    obj.services !== null &&
    !Array.isArray(obj.services) &&
    Object.keys(obj.services as Record<string, unknown>).length > 0
  );
}

/**
 * Parse a stack manifest JSON string. Returns a typed result or null if invalid.
 */
export function parseStackManifest(json: string): { services: Record<string, Record<string, unknown>> } | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isStackManifest(parsed)) return null;
    return parsed as { services: Record<string, Record<string, unknown>> };
  } catch (error) {
    logError('manifest.parseStackManifest', error);
    return null;
  }
}

/**
 * Extract service names from a stack manifest.
 * Returns empty array for non-stack manifests.
 */
export function getServiceNames(manifest: unknown): string[] {
  if (!isStackManifest(manifest)) return [];
  const obj = manifest as { services: Record<string, unknown> };
  return Object.keys(obj.services);
}
