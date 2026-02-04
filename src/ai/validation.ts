/**
 * Validation utilities for AI assistant
 * Provides schema validation for localStorage data and input sanitization
 */

import * as ipaddr from 'ipaddr.js';
import { parseHttpUrl, isUrlSsrfSafe } from '../utils/url';

// ============================================================================
// Settings Validation
// ============================================================================

export interface AISettings {
  ollamaEndpoint: string;
  model: string;
  saveHistory: boolean;
  enableThinking: boolean;
}

const DEFAULT_SETTINGS: AISettings = {
  ollamaEndpoint: 'http://localhost:11434',
  model: 'llama3.2',
  saveHistory: true,
  enableThinking: false,
};

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
 */
const INTERNAL_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^localhost\.localdomain$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.localdomain$/i,
  /^metadata\./i,
  /^instance-data\./i,
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

  // Return the normalized URL (removes trailing slashes, normalizes encoding)
  return parsed.origin;
}

/**
 * Validate settings object from localStorage
 * Returns validated settings or defaults if invalid
 */
export function validateSettings(data: unknown): AISettings {
  if (typeof data !== 'object' || data === null) {
    return DEFAULT_SETTINGS;
  }

  const obj = data as Record<string, unknown>;
  const result: AISettings = { ...DEFAULT_SETTINGS };

  // Validate ollamaEndpoint
  if (typeof obj.ollamaEndpoint === 'string') {
    const validatedUrl = validateEndpointUrl(obj.ollamaEndpoint);
    if (validatedUrl) {
      result.ollamaEndpoint = validatedUrl;
    }
  }

  // Validate model (string, max length)
  if (typeof obj.model === 'string' && obj.model.length > 0 && obj.model.length <= 256) {
    // Only allow alphanumeric, hyphens, underscores, colons, and dots
    if (/^[a-zA-Z0-9\-_.:]+$/.test(obj.model)) {
      result.model = obj.model;
    }
  }

  // Validate booleans
  if (typeof obj.saveHistory === 'boolean') {
    result.saveHistory = obj.saveHistory;
  }

  if (typeof obj.enableThinking === 'boolean') {
    result.enableThinking = obj.enableThinking;
  }

  return result;
}

// ============================================================================
// Chat Message Validation
// ============================================================================

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  timestamp: number;
  toolCalls?: unknown[];
  toolCallId?: string;
  toolName?: string;
  isStreaming?: boolean;
  error?: string;
}

// Maximum message content length (1MB should be more than enough)
const MAX_CONTENT_LENGTH = 1024 * 1024;

// Maximum number of messages to load from history
const MAX_HISTORY_MESSAGES = 100;

/**
 * Validate a single chat message
 */
function validateMessage(msg: unknown): ChatMessage | null {
  if (typeof msg !== 'object' || msg === null) {
    return null;
  }

  const obj = msg as Record<string, unknown>;

  // Required fields
  if (typeof obj.id !== 'string' || obj.id.length === 0 || obj.id.length > 64) {
    return null;
  }

  if (obj.role !== 'user' && obj.role !== 'assistant' && obj.role !== 'tool') {
    return null;
  }

  if (typeof obj.content !== 'string' || obj.content.length > MAX_CONTENT_LENGTH) {
    return null;
  }

  if (typeof obj.timestamp !== 'number' || !Number.isFinite(obj.timestamp)) {
    return null;
  }

  // Build validated message
  const validated: ChatMessage = {
    id: obj.id,
    role: obj.role,
    content: obj.content,
    timestamp: obj.timestamp,
  };

  // Optional fields
  if (typeof obj.thinking === 'string' && obj.thinking.length <= MAX_CONTENT_LENGTH) {
    validated.thinking = obj.thinking;
  }

  if (typeof obj.toolCallId === 'string' && obj.toolCallId.length <= 64) {
    validated.toolCallId = obj.toolCallId;
  }

  if (typeof obj.toolName === 'string' && obj.toolName.length <= 64) {
    validated.toolName = obj.toolName;
  }

  if (typeof obj.error === 'string' && obj.error.length <= 2048) {
    validated.error = obj.error;
  }

  // Don't restore isStreaming state (should always start as false)
  validated.isStreaming = false;

  // Don't restore toolCalls from localStorage - they're user-controlled and could be
  // malformed/oversized. Historical tool calls aren't needed for conversation continuity.

  return validated;
}

/**
 * Validate chat history from localStorage
 * Returns validated messages array or empty array if invalid
 */
export function validateChatHistory(data: unknown): ChatMessage[] {
  if (!Array.isArray(data)) {
    return [];
  }

  const validated: ChatMessage[] = [];

  // Limit the number of messages we process - keep the most recent ones
  const messagesToProcess = data.slice(-MAX_HISTORY_MESSAGES);

  for (const msg of messagesToProcess) {
    const validatedMsg = validateMessage(msg);
    if (validatedMsg) {
      validated.push(validatedMsg);
    }
  }

  return validated;
}

// ============================================================================
// Tool Argument Validation
// ============================================================================

// Re-export VALID_TOOL_NAMES and isValidToolName from tools.ts for backwards compatibility
// This ensures a single source of truth for valid tool names
export { VALID_TOOL_NAMES, isValidToolName } from './tools';

/**
 * Sanitize tool arguments - ensure they're a valid object
 */
export function sanitizeToolArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return {};
  }

  // Ensure all values are safe (no prototype pollution)
  const sanitized: Record<string, unknown> = {};
  for (const key of Object.keys(args)) {
    // Skip prototype-pollution vectors
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    sanitized[key] = (args as Record<string, unknown>)[key];
  }

  return sanitized;
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
