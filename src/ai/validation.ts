/**
 * Validation utilities for AI assistant
 * Provides schema validation for localStorage data and input sanitization
 */

import { z } from 'zod';
import * as ipaddr from 'ipaddr.js';
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
  'carrierGradeNat', // 100.64.0.0/10 — shared CGNAT space, reaches LAN gateways
  // IPv6 forms that embed an IPv4 address: without these, literals like
  // ::ffff:169.254.169.254 (ipv4Mapped) or 64:ff9b::a9fe:a9fe (NAT64) classify
  // as their own range and slip past the IPv4 block above, re-opening the
  // metadata/loopback/LAN target that block exists to close.
  'ipv4Mapped', // ::ffff:0:0/96 — IPv4-mapped IPv6
  'rfc6052', // 64:ff9b::/96 — NAT64 well-known prefix
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
  /\.sslip\.io$/i, // risk outweighs false positives for AI API/provider URLs.
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

export const AISettingsSchema = z.object({
  saveHistory: z.boolean().catch(true),
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
  // Transient/UI markers preserved through validation so filters and
  // rehydrate branches downstream can act on them. Whitelist explicitly —
  // every new flag on ChatMessage must be decided about here:
  //  - isStreaming → `rehydrateChatHistory` in persistence.ts marks the
  //    message Interrupted on reload
  //  - awaitingConfirmation → same, for tool messages without a paired
  //    pendingConfirmation (intentionally not persisted)
  //  - transactionInFlight → same, for confirmed transactions whose outcome
  //    was not observed before reload
  //  - local → toChatApiMessages filter; synthesized UI text (e.g. /help)
  //    must not be replayed back to the model after reload
  // Note: `card` is intentionally NOT whitelisted (cards snapshot live state
  // that goes stale across reloads — see saveHistory comment in persistence.ts).
  isStreaming: z.boolean().optional().catch(undefined),
  awaitingConfirmation: z.boolean().optional().catch(undefined),
  transactionInFlight: z.boolean().optional().catch(undefined),
  local: z.boolean().optional().catch(undefined),
}).transform((msg): ChatMessage => ({
  ...msg,
  // Normalize undefined → false so downstream truthiness checks behave.
  // The old transform hard-set `isStreaming: false`, which clobbered a
  // persisted `true` and short-circuited the rehydrate Interrupted branch.
  isStreaming: msg.isStreaming ?? false,
  awaitingConfirmation: msg.awaitingConfirmation ?? false,
  transactionInFlight: msg.transactionInFlight ?? false,
  local: msg.local ?? false,
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
