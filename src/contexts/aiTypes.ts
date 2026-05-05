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
 *  `dnsStatuses` slice — no per-pill polling. */
export interface DeployDnsStatusCardData {
  appName: string;
  fqdn: string;
  leaseUuid: string;
  serviceName: string;
  expectedCnameTarget?: string;
  isApex: boolean;
}

/** Discriminated union for message display cards. */
export type MessageCard =
  | { type: 'logs'; data: LogsCardData }
  | { type: 'help'; data: null }
  | { type: 'custom_domain'; data: CustomDomainCardData }
  | { type: 'deploy_dns_status'; data: DeployDnsStatusCardData };

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
}

export interface PendingConfirmation {
  id: string;
  action: PendingAction;
  messageId: string;
}
