/**
 * Type definitions for the tool executor
 */

import type { CosmosClientManager } from '@manifest-network/manifest-mcp-core';
import type { DeployProgress } from '../progress';
import type { AppEntry } from '../../registry/appRegistry';
import type { MessageCard } from '../../contexts/aiTypes';

export interface SignResult {
  pub_key: { type: string; value: string };
  signature: string;
}

export type SignArbitraryFn = (address: string, data: string) => Promise<SignResult>;

export interface PayloadAttachment {
  bytes: Uint8Array;
  filename?: string;
  size: number;
  hash: string; // Pre-computed SHA-256 hex
}

/**
 * Per-tool successful-result data shapes.
 *
 * `data: unknown` on ToolResultSuccess accepts anything, but the AI consumes
 * a JSON serialization of this object on its next stream turn — so renaming
 * a field is a silent contract change. The shapes below pin the user-visible
 * contract for the tools whose output is also rendered by a card or referenced
 * by other tools, so refactors trip the typechecker.
 *
 * Today only a subset of tools is typed; the rest fall back to `unknown` until
 * we get to them. Adding a tool to the map is opt-in and non-breaking.
 */
export interface ToolDataMap {
  app_status: {
    name: string;
    status: string;
    size: string;
    image?: string;
    serviceImages?: Record<string, string>;
    url?: string;
    chainState: string;
    created: string;
    customDomains?: { serviceName: string; customDomain: string }[];
  };
  list_apps: {
    apps: Array<{
      name: string;
      status: string;
      size: string;
      image?: string;
      url?: string;
      created: string;
    }>;
    count: number;
  };
  get_logs: {
    app_name: string;
    logs: Record<string, string>;
    truncated: boolean;
  };
  get_balance: {
    credits: number;
    spending_per_hour: number;
    hours_remaining: number | null;
    running_apps: number;
  };
}

/** Lookup helper — `ToolData<'app_status'>` resolves to that tool's data shape. */
export type ToolData<N extends keyof ToolDataMap> = ToolDataMap[N];

/**
 * Successful tool execution result
 */
interface ToolResultSuccess {
  success: true;
  requiresConfirmation?: false;
  data: unknown;
  displayCard?: MessageCard;
  error?: never;
  confirmationMessage?: never;
  pendingAction?: never;
}

/**
 * Failed tool execution result
 */
interface ToolResultFailure {
  success: false;
  requiresConfirmation?: false;
  error: string;
  data?: never;
  confirmationMessage?: never;
  pendingAction?: never;
}

/**
 * Tool result that requires user confirmation before execution
 */
interface ToolResultConfirmation {
  success: true;
  requiresConfirmation: true;
  confirmationMessage: string;
  pendingAction: {
    toolName: string;
    args: Record<string, unknown>;
  };
  data?: never;
  error?: never;
}

/**
 * Discriminated union for tool execution results.
 * - Success: { success: true, data: ... }
 * - Failure: { success: false, error: '...' }
 * - Requires confirmation: { success: true, requiresConfirmation: true, ... }
 */
export type ToolResult = ToolResultSuccess | ToolResultFailure | ToolResultConfirmation;

export interface AppRegistryAccess {
  getApps: (address: string) => AppEntry[];
  getApp: (address: string, name: string) => AppEntry | null;
  findApp: (address: string, name: string) => AppEntry | null;
  getAppByLease: (address: string, leaseUuid: string) => AppEntry | null;
  addApp: (address: string, entry: AppEntry) => AppEntry;
  updateApp: (address: string, leaseUuid: string, updates: Partial<Omit<AppEntry, 'leaseUuid'>>) => AppEntry | null;
}

export interface ToolExecutorOptions {
  clientManager: CosmosClientManager | null;
  address: string | undefined;
  signArbitrary?: (address: string, data: string) => Promise<SignResult>;
  onProgress?: (progress: DeployProgress) => void;
  appRegistry?: AppRegistryAccess;
  signal?: AbortSignal;
}

export interface PendingAction {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  payload?: PayloadAttachment;
}
