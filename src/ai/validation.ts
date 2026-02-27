/**
 * Validation utilities for AI assistant
 * Provides schema validation for localStorage data and input sanitization
 */

import { z } from 'zod';
import * as ipaddr from 'ipaddr.js';
import { parseHttpUrl, isUrlSsrfSafe } from '../utils/url';
import type { ChatMessage } from '../contexts/aiTypes';

// ============================================================================
// Settings Validation
// ============================================================================

/**
 * IP ranges that should be blocked for SSRF protection.
 * Uses ipaddr.js range classifications.
 */
const BLOCKED_IP_RANGES = new Set([
  'unspecified', // 0.0.0.0, ::
  'loopback', // 127.x.x.x, ::1
  'private', // 10.x.x.x, 172.16-31.x.x, 192.168.x.x, fc00::/7
  'linkLocal', // 169.254.x.x, fe80::/10
  'multicast', // 224.0.0.0/4, ff00::/8
  'reserved', // Various reserved ranges
  'benchmarking', // 198.18.0.0/15
  'amt', // 192.52.193.0/24
  'as112', // 192.31.196.0/24, 192.175.48.0/24
  'as112v6', // 2001:4:112::/48
  'deprecated', // Various deprecated ranges
  'orchid', // 2001:10::/28
  'orchid2', // 2001:20::/28
  '6to4', // 2002::/16
  'teredo', // 2001::/32
  'uniqueLocal', // fc00::/7
]);

/**
 * Hostname patterns that indicate internal/private infrastructure.
 * Includes DNS-to-IP mapping services (nip.io, xip.io, sslip.io) that can
 * resolve to private IPs, enabling DNS rebinding attacks.
 */
const INTERNAL_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^localhost\.localdomain$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.localdomain$/i,
  /^metadata\./i,
  /^instance-data\./i,
  /\.nip\.io$/i,  // Blocks ALL subdomains — acceptable since these services
  /\.xip\.io$/i,  // are primarily used for local dev, and the DNS rebinding
  /\.sslip\.io$/i, // risk outweighs false positives for Ollama/provider URLs.
];

/**
 * Check if a hostname is a private/internal address that should be blocked (SSRF protection).
 * Uses ipaddr.js for robust IP classification, handling edge cases like octal/hex notation.
 * Exported for testing purposes.
 */
export function isPrivateHost(hostname: string): boolean {
  // Check hostname patterns first (localhost, .local, .internal, etc.)
  if (INTERNAL_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))) {
    return true;
  }

  // Strip brackets from IPv6 addresses
  const cleanHostname = hostname.replace(/^\[|\]$/g, '');

  // Try to parse as IP address using ipaddr.js
  if (ipaddr.isValid(cleanHostname)) {
    try {
      const addr = ipaddr.parse(cleanHostname);
      const range = addr.range();
      return BLOCKED_IP_RANGES.has(range);
    } catch {
      // If parsing fails, block it to be safe
      return true;
    }
  }

  // Not an IP address, allow it (DNS names will be resolved by the browser)
  return false;
}

/**
 * Validate and sanitize an Ollama endpoint URL
 * Returns null if the URL is invalid or potentially dangerous
 *
 * Security: Blocks SSRF attacks by rejecting private/internal IP addresses
 */
export function validateEndpointUrl(url: string): string | null {
  if (typeof url !== 'string' || url.length === 0) {
    return null;
  }

  // Limit URL length to prevent abuse
  if (url.length > 2048) {
    return null;
  }

  const parsed = parseHttpUrl(url);
  if (!parsed) {
    return null;
  }

  // Disallow URLs with credentials
  if (parsed.username || parsed.password) {
    return null;
  }

  // Disallow data: or javascript: schemes that might be encoded
  const normalized = parsed.href.toLowerCase();
  if (normalized.includes('javascript:') || normalized.includes('data:')) {
    return null;
  }

  if (!isUrlSsrfSafe(parsed)) {
    return null;
  }

  // Return the normalized URL (preserves path, strips query/fragment/trailing slashes)
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.origin + pathname;
}

export const AISettingsSchema = z.object({
  ollamaEndpoint: z.string()
    .transform((url) => validateEndpointUrl(url))
    .pipe(z.string())
    .catch('http://localhost:11434'),
  model: z.string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9\-_.:]+$/)
    .catch('mistral-small3.2:24b'),
  saveHistory: z.boolean().catch(true),
  enableThinking: z.boolean().catch(false),
});

export type AISettings = z.infer<typeof AISettingsSchema>;

/**
 * Validate settings object from localStorage.
 * Returns validated settings or defaults if invalid.
 */
export function validateSettings(data: unknown): AISettings {
  const result = AISettingsSchema.safeParse(data);
  if (result.success) return result.data;
  return AISettingsSchema.parse({});
}

// ============================================================================
// Chat Message Validation
// ============================================================================

// ChatMessage is imported from '../contexts/aiTypes' — single source of truth.

// Maximum message content length (1MB should be more than enough)
const MAX_CONTENT_LENGTH = 1024 * 1024;

// Maximum number of messages to load from history
const MAX_HISTORY_MESSAGES = 100;

const PersistedMessageSchema = z.object({
  id: z.string().min(1).max(64),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string().max(MAX_CONTENT_LENGTH),
  timestamp: z.number().finite(),
  thinking: z.string().max(MAX_CONTENT_LENGTH).optional().catch(undefined),
  toolCallId: z.string().max(64).optional().catch(undefined),
  toolName: z.string().max(64).optional().catch(undefined),
  error: z.string().max(2048).optional().catch(undefined),
}).transform((msg): ChatMessage => ({
  ...msg,
  // Don't restore isStreaming state (should always start as false)
  isStreaming: false,
  // Don't restore toolCalls from localStorage - they're user-controlled and could be
  // malformed/oversized. Historical tool calls aren't needed for conversation continuity.
}));

/**
 * Validate chat history from localStorage
 * Returns validated messages array or empty array if invalid
 */
export function validateChatHistory(data: unknown): ChatMessage[] {
  if (!Array.isArray(data)) {
    return [];
  }

  // Limit the number of messages we process - keep the most recent ones
  const messagesToProcess = data.slice(-MAX_HISTORY_MESSAGES);

  const validated: ChatMessage[] = [];
  for (const msg of messagesToProcess) {
    const result = PersistedMessageSchema.safeParse(msg);
    if (result.success) {
      validated.push(result.data);
    }
  }
  return validated;
}

// ============================================================================
// Tool Argument Validation
// ============================================================================

/**
 * Recursively sanitize a value, stripping prototype-pollution keys from any
 * nested objects.  Primitives and arrays are passed through (arrays have their
 * elements sanitized).
 */
function sanitizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  const sanitized: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    sanitized[key] = sanitizeValue((value as Record<string, unknown>)[key]);
  }
  return sanitized;
}

/**
 * Sanitize tool arguments - ensure they're a valid object with no
 * prototype-pollution vectors at any nesting depth.
 */
export function sanitizeToolArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return {};
  }

  return sanitizeValue(args) as Record<string, unknown>;
}

// ============================================================================
// Input Validation
// ============================================================================

// Maximum user input length (64KB)
export const MAX_INPUT_LENGTH = 64 * 1024;

/**
 * Validate and sanitize user input
 */
export function validateUserInput(input: string): string | null {
  if (typeof input !== 'string') {
    return null;
  }

  // Trim and check length
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INPUT_LENGTH) {
    return null;
  }

  return trimmed;
}
