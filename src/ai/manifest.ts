/**
 * Manifest builder for image-based deploys.
 * Builds a provider-compatible manifest JSON from a Docker image reference,
 * computes its SHA-256 hash, and returns a PayloadAttachment.
 *
 * Delegates core manifest construction to @manifest-network/manifest-mcp-fred,
 * adding Barney-specific behavior: port string normalization, password generation,
 * tmpfs/expose string splitting, payload hashing, and error handling.
 *
 * Supports both single-service and stack (multi-service) manifests.
 * Stack manifests use the `{ "services": { ... } }` format, where each
 * service is a named container with its own image, ports, env, etc.
 */

import {
  buildManifest as fredBuildManifest,
  mergeManifest as fredMergeManifest,
  validateServiceName as fredValidateServiceName,
  type BuildManifestOptions as FredBuildManifestOptions,
} from '@manifest-network/manifest-mcp-fred';
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
 * Auto-generate passwords for empty env values and values ending with "/".
 */
function processEnv(env: Record<string, string>): Record<string, string> {
  const processed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === '') {
      processed[key] = generatePassword();
    } else if (value.endsWith('/')) {
      processed[key] = value + generatePassword();
    } else {
      processed[key] = value;
    }
  }
  return processed;
}

/**
 * Split a comma-separated string into a trimmed, non-empty array.
 * Returns undefined if the result would be empty (so fred omits the field).
 */
function splitCsv(value: string): string[] | undefined {
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** Return the record if non-empty, undefined otherwise. */
function nonEmpty<T extends Record<string, unknown>>(obj: T | undefined): T | undefined {
  return obj && Object.keys(obj).length > 0 ? obj : undefined;
}

/**
 * Convert Barney's BuildManifestOptions to fred's BuildManifestOptions.
 * Transforms fields with different shapes: port string -> ports record,
 * env password generation, tmpfs/expose comma-string -> arrays.
 * Empty objects are filtered to undefined so fred omits them.
 */
function toFredOptions(opts: BuildManifestOptions): FredBuildManifestOptions {
  const env = nonEmpty(opts.env);
  return {
    image: opts.image,
    ports: opts.port ? normalizePorts(opts.port) : {},
    env: env ? processEnv(env) : undefined,
    tmpfs: opts.tmpfs ? splitCsv(opts.tmpfs) : undefined,
    expose: opts.expose ? splitCsv(opts.expose) : undefined,
    command: opts.command,
    args: opts.args,
    user: opts.user,
    health_check: opts.health_check,
    stop_grace_period: opts.stop_grace_period,
    init: opts.init,
    labels: nonEmpty(opts.labels),
    depends_on: nonEmpty(opts.depends_on),
  };
}

/**
 * Build a manifest JSON from Docker image parameters, compute its hash,
 * and return a PayloadAttachment ready for the deploy flow.
 *
 * Delegates manifest construction to @manifest-network/manifest-mcp-fred,
 * adding password generation, payload hashing, and size validation.
 */
export async function buildManifest(opts: BuildManifestOptions): Promise<BuildManifestResult> {
  const fredOpts = toFredOptions(opts);
  const manifest = fredBuildManifest(fredOpts);
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
 * Delegates to fred's mergeManifest (env/ports/labels merge with override,
 * other fields carry forward). Returns newManifest unchanged on parse errors.
 *
 * Fred's mergeManifest only throws on invalid oldManifestJson (bad JSON or
 * non-object), so catching all errors matches the original Barney behavior
 * of graceful fallback without fragile error message matching.
 */
export function mergeManifest(
  newManifest: Record<string, unknown>,
  oldManifestJson: string
): Record<string, unknown> {
  try {
    return fredMergeManifest(newManifest, oldManifestJson);
  } catch (error) {
    logError('manifest.mergeManifest.parseOld', error);
    return newManifest;
  }
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
 *
 * Wraps @manifest-network/manifest-mcp-fred's validateServiceName (boolean)
 * with Barney's error message convention.
 */
export function validateServiceName(name: string): string | null {
  if (!name) return 'Service name is required.';
  if (name.length > 63) return 'Service name must be 63 characters or fewer.';
  if (!fredValidateServiceName(name)) {
    return 'Service name must be a valid DNS label: lowercase alphanumeric with hyphens, no leading/trailing hyphen.';
  }
  return null;
}

/**
 * Build a stack manifest JSON from multiple service configs, compute its hash,
 * and return a PayloadAttachment ready for the deploy flow.
 *
 * The resulting manifest format: `{ "services": { "web": {...}, "db": {...} } }`
 *
 * Uses @manifest-network/manifest-mcp-fred's buildManifest per service,
 * with Barney-specific stack wrapping, password generation, and payload hashing.
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
    services[name] = fredBuildManifest(toFredOptions(cfg));
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
