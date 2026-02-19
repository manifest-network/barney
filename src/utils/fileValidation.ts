/**
 * Shared file validation utilities for payload uploads.
 * Used by both LeasesTab (manual upload) and AIContext (chat attachment).
 */

import { MAX_PAYLOAD_SIZE } from './hash';
import { MAX_FILENAME_LENGTH } from '../config/constants';

/** Allowed MIME types for file uploads */
export const ALLOWED_FILE_TYPES = [
  'text/plain',
  'text/yaml',
  'text/x-yaml',
  'application/x-yaml',
  'application/json',
];

/** Allowed file extensions */
export const ALLOWED_FILE_EXTENSIONS = ['.yaml', '.yml', '.json', '.txt'];

/**
 * Validates a file before upload to prevent malicious file uploads.
 *
 * **Security:** Prevents various upload attacks by checking:
 * - Empty file rejection (prevents no-op uploads)
 * - File size limits (prevents DoS via large uploads)
 * - Filename length (prevents path traversal and buffer overflow)
 * - File extension validation (primary check, always enforced)
 * - MIME type validation (secondary check when browser provides one)
 *
 * Note: This is client-side validation. Always validate server-side as well.
 *
 * @param file - The File object from an input element
 * @returns Object with valid: boolean and optional error message
 */
export function validateFile(file: File): { valid: boolean; error?: string } {
  // Reject empty files
  if (file.size === 0) {
    return { valid: false, error: 'File is empty' };
  }

  // Check file size
  if (file.size > MAX_PAYLOAD_SIZE) {
    return { valid: false, error: `File exceeds maximum size of ${MAX_PAYLOAD_SIZE / 1024}KB` };
  }

  // Check filename length
  if (file.name.length > MAX_FILENAME_LENGTH) {
    return { valid: false, error: 'Filename is too long' };
  }

  // Get file extension
  const dotIndex = file.name.lastIndexOf('.');
  const fileExtension = dotIndex >= 0 ? file.name.toLowerCase().substring(dotIndex) : '';

  // Always validate extension (defense-in-depth: MIME types can be unreliable)
  if (!ALLOWED_FILE_EXTENSIONS.includes(fileExtension)) {
    return { valid: false, error: `File extension "${fileExtension || '(none)'}" is not allowed. Use .yaml, .yml, .json, or .txt files.` };
  }

  // Also validate MIME type when the browser provides one
  if (file.type && !ALLOWED_FILE_TYPES.includes(file.type)) {
    return { valid: false, error: `File type "${file.type}" is not allowed. Use .yaml, .yml, .json, or .txt files.` };
  }

  return { valid: true };
}

/**
 * Validates that file content is a well-formed manifest.
 *
 * - JSON files: parsed and structurally validated (must have `image` or `services`)
 * - YAML files: lightweight check for required top-level keys (no parser available)
 * - .txt files: tries JSON first, then YAML-style check
 */
export function validateManifestContent(
  bytes: Uint8Array,
  filename: string,
): { valid: boolean; error?: string } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { valid: false, error: 'File is not valid UTF-8 text' };
  }

  if (text.trim().length === 0) {
    return { valid: false, error: 'File is empty' };
  }

  const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));

  if (ext === '.json') {
    return validateJsonManifest(text);
  }

  if (ext === '.yaml' || ext === '.yml') {
    return validateYamlManifest(text);
  }

  // .txt — try JSON first, fall back to YAML-style check
  const jsonResult = validateJsonManifest(text);
  if (jsonResult.valid) return jsonResult;
  return validateYamlManifest(text);
}

function validateJsonManifest(text: string): { valid: boolean; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { valid: false, error: `Invalid JSON: ${e instanceof SyntaxError ? e.message : 'parse error'}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, error: 'Manifest must be a JSON object' };
  }

  return validateManifestStructure(parsed as Record<string, unknown>);
}

/** RFC 1123 DNS label: lowercase alphanumeric + hyphens, 1-63 chars, no leading/trailing hyphen. */
const SERVICE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function validateManifestStructure(manifest: Record<string, unknown>): { valid: boolean; error?: string } {
  if ('services' in manifest) {
    const services = manifest.services;
    if (typeof services !== 'object' || services === null || Array.isArray(services)) {
      return { valid: false, error: '"services" must be an object mapping service names to configs' };
    }
    const entries = Object.entries(services as Record<string, unknown>);
    if (entries.length === 0) {
      return { valid: false, error: '"services" must contain at least one service' };
    }
    for (const [name, config] of entries) {
      if (!SERVICE_NAME_RE.test(name)) {
        return { valid: false, error: `Invalid service name "${name}": must be a lowercase DNS label (a-z, 0-9, hyphens, 1-63 chars)` };
      }
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        return { valid: false, error: `Service "${name}" must be an object` };
      }
      if (!(config as Record<string, unknown>).image || typeof (config as Record<string, unknown>).image !== 'string') {
        return { valid: false, error: `Service "${name}" is missing a valid "image" field` };
      }
    }
    return { valid: true };
  }

  if (!manifest.image || typeof manifest.image !== 'string') {
    return { valid: false, error: 'Manifest is missing a valid "image" field' };
  }

  return { valid: true };
}

function validateYamlManifest(text: string): { valid: boolean; error?: string } {
  const hasImage = /^image:\s/m.test(text);
  const hasServices = /^services:\s*(#.*)?$/m.test(text);

  if (!hasImage && !hasServices) {
    return { valid: false, error: 'Manifest must contain an "image" or "services" field' };
  }

  return { valid: true };
}
