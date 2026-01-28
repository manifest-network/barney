/**
 * Shared file validation utilities for payload uploads.
 * Used by both LeasesTab (manual upload) and AIContext (chat attachment).
 */

import { MAX_PAYLOAD_SIZE } from './hash';

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

/** Maximum file name length to prevent path traversal */
const MAX_FILENAME_LENGTH = 255;

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
