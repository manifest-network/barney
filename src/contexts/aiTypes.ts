/**
 * Shared types for the AI context and related hooks.
 * Extracted to avoid circular dependencies between AIContext and custom hooks.
 */

import type { ToolCall } from '../api/morpheus';
import type { PendingAction } from '../ai/toolExecutor';

/** Data for a logs display card. */
export interface LogsCardData {
  app_name: string;
  logs: Record<string, string>;
  truncated: boolean;
}

/**
 * Data for a custom-domain status card.
 * `expectedCnameTarget` is the provider-issued FQDN that the user's CNAME should point at.
 * `expectedAddress` is the wallet that issued the SetItemCustomDomain TX (for cross-wallet hint).
 *
 * Multi-domain stacks pass `domains: DomainAssignmentInCard[]` for the consolidated
 * card; single-domain (or empty-form) cards use the legacy `fqdn` + `serviceName`
 * pair. `serviceNames` (when present) drives the empty-form service picker.
 */
export interface DomainAssignmentInCard {
  serviceName: string;
  customDomain: string;
  expectedCnameTarget?: string;
}

export interface CustomDomainCardData {
  appName: string;
  fqdn: string;
  leaseUuid: string;
  serviceName: string;
  expectedCnameTarget?: string;
  expectedAddress?: string;
  /** Set on multi-domain stacks. When present, the card renders the consolidated
   *  rows view instead of the single-domain status view. */
  domains?: readonly DomainAssignmentInCard[];
  /** Available stack services. Used by the empty-form service picker. */
  serviceNames?: readonly string[];
}

/** Compact inline pill emitted by `executeConfirmedDeployApp` when a single
 *  custom domain was attached during deploy. Reads DNS status from the shared
 *  `dnsStatuses` slice — no per-pill polling.
 *
 *  Deprecated for new emissions — `executeConfirmedDeployApp` now emits the
 *  richer `app` card with the DNS row embedded. The variant remains so chat
 *  history persisted before the switch still renders. */
export interface DeployDnsStatusCardData {
  appName: string;
  fqdn: string;
  leaseUuid: string;
  serviceName: string;
  expectedCnameTarget?: string;
  isApex: boolean;
}

/** Port mapping shape returned by the provider connection info. */
export interface AppCardPortMapping {
  host_ip: string;
  host_port: number;
}

/** Per-service connection info for stack deployments. */
export interface AppCardServiceInfo {
  ports?: Record<string, AppCardPortMapping>;
  instances?: { fqdn?: string; ports?: Record<string, AppCardPortMapping> }[];
}

/** Connection metadata embedded in an AppCard. Mirrors `AppEntry.connection`
 *  but typed to what AppCard actually uses. */
export interface AppCardConnection {
  host: string;
  fqdn?: string;
  ports?: Record<string, AppCardPortMapping>;
  instances?: { fqdn?: string; ports?: Record<string, AppCardPortMapping> }[];
  services?: Record<string, AppCardServiceInfo>;
}

/** Embedded custom-domain row for AppCard. Reads its live status from the
 *  shared `dnsStatuses` slice. */
export interface AppCardCustomDomain {
  fqdn: string;
  leaseUuid: string;
  serviceName: string;
  expectedCnameTarget?: string;
  isApex: boolean;
}

/** Data for the `app` deploy-success card. */
export interface AppCardData {
  name: string;
  url?: string;
  connection?: AppCardConnection;
  status: string;
  customDomain?: AppCardCustomDomain;
}

/** Discriminated union for message display cards. */
export type MessageCard =
  | { type: 'logs'; data: LogsCardData }
  | { type: 'help'; data: null }
  | { type: 'custom_domain'; data: CustomDomainCardData }
  | { type: 'deploy_dns_status'; data: DeployDnsStatusCardData }
  | { type: 'app'; data: AppCardData };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  toolDescription?: string;
  isStreaming?: boolean;
  error?: string;
  card?: MessageCard;
  /** True for messages synthesized by the UI (e.g. /help text) — they render
   *  in chat but must NOT be replayed back to the model on the next turn,
   *  otherwise the model treats its own UI canned text as real assistant output. */
  local?: boolean;
}

export interface PendingConfirmation {
  id: string;
  action: PendingAction;
  messageId: string;
}
