/**
 * Type definitions for the tool executor
 */

import type { CosmosClientManager, SignArbitraryResult } from '@manifest-network/manifest-sdk';
import type { createAuthTokens } from '@manifest-network/manifest-sdk/deploy';
import type { ProviderAuthPort } from '@manifest-network/manifest-mcp-fred';
import type { DeployProgress } from '../progress';
import type { AppEntry } from '../../registry/appRegistry';
import type { MessageCard } from '../../contexts/aiTypes';
import type { ResolvedSkuTier } from '../../api/skuTiers';

export interface SignResult {
  pub_key: { type: string; value: string };
  signature: string;
}

/**
 * Compile-time parity guard (PR 0): Barney's SignResult must stay structurally
 * assignable to the SDK's SignArbitraryResult (both ADR-036 `{ signature, pub_key }`).
 * PR 5 wires the auth-token factory against the SDK type; if SignResult ever drifts,
 * the `T extends U` constraint fails and `tsc` errors right here.
 */
type AssertAssignable<T extends U, U> = T;
export type _SignResultParity = AssertAssignable<SignResult, SignArbitraryResult>;

/** The signer-bound ADR-036 auth-token factory returned by the SDK's `createAuthTokens`. */
export type AuthTokens = ReturnType<typeof createAuthTokens>;

/**
 * Composition-root signing capability. `providerAuth` is the single ADR-036
 * minter (one AuthTimestampTracker); `authTokens` is a thin address-binding
 * adapter over the SAME providerAuth instance; `withSign` serializes chain-TX
 * broadcasts on the mutex the minter's signArbitrary also uses.
 */
export interface SigningContext {
  /** The single ADR-036 token minter. ctx.providerAuth for deployManifest (C2). Address-PARAM. */
  providerAuth: ProviderAuthPort;
  /** Address-BOUND adapter over the SAME `providerAuth` instance (never a 2nd createProviderAuth). */
  authTokens: AuthTokens;
  withSign: <T>(fn: () => Promise<T>) => Promise<T>;
}

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
  /** Root-built signing capability (auth-token factory + shared sign lock). */
  signing?: SigningContext;
  onProgress?: (progress: DeployProgress) => void;
  appRegistry?: AppRegistryAccess;
  signal?: AbortSignal;
  /** Resolved SKU tier list from the AI store. An empty array means
   *  "not ready" — deploy executors must refuse with
   *  "Tier catalog unavailable" before any broadcast. */
  tiers: readonly ResolvedSkuTier[];
}

export interface PendingAction {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  payload?: PayloadAttachment;
}
