/**
 * Deploy-throw classification.
 *
 * Extracted verbatim from compositeTransactions.ts (ENG-576 refactor split).
 * Pure code motion — turns a deployManifest throw into barney's
 * registry/progress/ToolResult, using chain state as the source of truth.
 */

import { getLease, LeaseState } from '../../api/billing';
import { getLeaseProvision, getLeaseLogs, type FredLeaseStatus } from '../../api/fred';
import { asLeaseUuid, ManifestMCPError, ManifestMCPErrorCode } from '@manifest-network/manifest-sdk';
import { TerminalChainStateError } from '@manifest-network/manifest-sdk/deploy';
import { logError } from '../../utils/errors';
import type { ToolResult, ToolExecutorOptions, SigningContext } from './types';
import { resolveAppUrl } from './deployUrl';

/**
 * Best-effort fetch of provider logs and provision status for failed deploys.
 * Creates a fresh auth token since the original may be stale after long polling.
 * Never throws — failure to get logs must not mask the deploy error.
 */
async function fetchFailureLogs(
  providerUrl: string,
  leaseUuid: string,
  _address: string,
  signing: SigningContext | undefined
): Promise<string | null> {
  if (!signing) return null;

  try {
    const authToken = await signing.authTokens.getAuthToken(asLeaseUuid(leaseUuid));

    const parts: string[] = [];

    // Fetch provision status first — more structured than raw logs
    try {
      const provision = await getLeaseProvision(providerUrl, leaseUuid, authToken);
      if (provision.last_error) {
        parts.push(`Provision error (fail_count=${provision.fail_count}): ${provision.last_error}`);
      }
    } catch (error) {
      logError('deployError.fetchFailureLogs.provision', error);
    }

    // Fetch container logs
    try {
      const response = await getLeaseLogs(providerUrl, leaseUuid, authToken, 100);
      const logEntries = Object.entries(response.logs ?? {});
      if (logEntries.length > 0) {
        const logText = logEntries
          .map(([service, text]) => `[${service}]\n${typeof text === 'string' ? text : JSON.stringify(text)}`)
          .join('\n');
        parts.push(`Container logs:\n${logText}`);
      }
    } catch (error) {
      logError('deployError.fetchFailureLogs.logs', error);
    }

    if (parts.length === 0) return null;

    const combined = parts.join('\n\n');
    // Truncate to last ~2000 chars to avoid bloating LLM context
    if (combined.length > 2000) {
      return '...' + combined.slice(-2000);
    }
    return combined;
  } catch (error) {
    logError('deployError.fetchFailureLogs', error);
    return null;
  }
}

/** Chain-truth verdict for an ambiguous post-lease deployManifest throw (§3.7 case-2). */
type ChainDeployVerdict = 'running' | 'deploying' | 'failed';

/**
 * Slim getLease chain-check. ACTIVE → running; a non-terminal in-flight state
 * (PENDING / unspecified) → deploying; a terminal state (CLOSED/REJECTED/EXPIRED)
 * OR getLease unavailable (null or throw) → failed. Never throws.
 */
export async function classifyLeaseChainState(leaseUuid: string): Promise<ChainDeployVerdict> {
  try {
    const lease = await getLease(leaseUuid);
    if (!lease) return 'failed';
    if (lease.state === LeaseState.LEASE_STATE_ACTIVE) return 'running';
    if (
      lease.state === LeaseState.LEASE_STATE_CLOSED ||
      lease.state === LeaseState.LEASE_STATE_REJECTED ||
      lease.state === LeaseState.LEASE_STATE_EXPIRED
    ) {
      return 'failed';
    }
    return 'deploying';
  } catch (error) {
    logError('deployError.classifyLeaseChainState', error);
    return 'failed';
  }
}

interface DeployErrorContext {
  name: string;
  /** From the caller's captured onLeaseCreated value. undefined ⇒ case 1 (no lease). */
  leaseUuid?: string;
  providerUrl?: string;
  address: string;
  signing: SigningContext;
  appRegistry: NonNullable<ToolExecutorOptions['appRegistry']>;
  onProgress?: ToolExecutorOptions['onProgress'];
}

/**
 * Classify a deployManifest throw into barney's registry/progress/ToolResult.
 * Case 1 (raw Error with NO lease): create-lease rejected, no lease exists.
 * Case 2 (any non-terminal error, leaseUuid present): chain is the source of
 *   truth — getLease chain-check → running/deploying/failed. Keyed off
 *   `leaseUuid` rather than `error instanceof ManifestMCPError`: deployManifest
 *   currently wraps every post-lease throw in ManifestMCPError/
 *   TerminalChainStateError, so this is unreachable today, but it's
 *   defense-in-depth against that contract changing — an unexpected error
 *   type with a lease must still be resolved via chain state, not
 *   misclassified as "no lease" (Case 1).
 * Case 3 (TerminalChainStateError): straight failed, no chain-check.
 */
export async function handleDeployManifestError(
  error: unknown,
  ctx: DeployErrorContext,
): Promise<ToolResult> {
  const { name, leaseUuid, providerUrl, address, signing, appRegistry, onProgress } = ctx;

  // Case 3: chain-terminal — definitively failed, no chain re-check.
  if (error instanceof TerminalChainStateError) {
    if (leaseUuid) appRegistry.updateApp(address, leaseUuid, { status: 'failed' });
    onProgress?.({ phase: 'failed', detail: error.message });
    return { success: false, error: `Deployment failed: ${error.message}` };
  }

  // Case 2: ambiguous post-lease throw — chain is the source of truth.
  if (leaseUuid) {
    const errMessage = error instanceof Error ? error.message : String(error);
    const verdict = await classifyLeaseChainState(leaseUuid);
    if (verdict === 'running') {
      // The lease is active on-chain even though deployManifest threw AFTER
      // creating it (e.g. a provision-poll error on an app that came up anyway).
      // Resolve the URL/connection from the provider so the app shows a
      // clickable link and batch counts it as a real success — not a bare name.
      // resolveAppUrl try/catches internally (url:undefined on failure).
      const { url: connectionUrl, connection } = providerUrl
        ? await resolveAppUrl(providerUrl, leaseUuid, {} as FredLeaseStatus, address, signing, 'deployError.handleDeployManifestError')
        : { url: undefined, connection: undefined };
      appRegistry.updateApp(address, leaseUuid, {
        status: 'running',
        url: connectionUrl,
        connection: connection ? JSON.parse(JSON.stringify(connection)) : undefined,
      });
      onProgress?.({ phase: 'ready', detail: 'App is live!' });
      return {
        success: true,
        data: { message: `App "${name}" is live!`, name, url: connectionUrl, status: 'running' },
        displayCard: {
          type: 'app' as const,
          data: { name, url: connectionUrl, status: 'running', connection: connection ? JSON.parse(JSON.stringify(connection)) : undefined },
        },
      };
    }
    if (verdict === 'deploying') {
      appRegistry.updateApp(address, leaseUuid, { status: 'deploying' });
      onProgress?.({ phase: 'failed', detail: `Provisioning timed out. Use app_status("${name}") to check progress.` });
      return {
        success: true,
        data: {
          message: `App "${name}" is still deploying. Use app_status("${name}") to check progress.`,
          name,
          status: 'deploying',
        },
      };
    }
    // verdict === 'failed'
    appRegistry.updateApp(address, leaseUuid, { status: 'failed' });
    onProgress?.({ phase: 'failed', detail: errMessage });
    const skipLogs = error instanceof ManifestMCPError && error.code === ManifestMCPErrorCode.OPERATION_CANCELLED;
    const diagnostics = skipLogs || !providerUrl
      ? null
      : await fetchFailureLogs(providerUrl, leaseUuid, address, signing);
    // barney copy — NOT the SDK's "…close_lease" text (barney has no close_lease tool).
    const errorMsg = diagnostics
      ? `Deployment failed: ${errMessage}\n\n${diagnostics}`
      : `Deployment failed: ${errMessage}`;
    return { success: false, error: errorMsg };
  }

  // Case 1: raw Error with NO lease (create-lease rejected) — surface the
  // raw error; no failure-log fetch (there's no lease to fetch logs for).
  const message = error instanceof Error ? error.message : 'Deployment failed';
  onProgress?.({ phase: 'failed', detail: message });
  return { success: false, error: message };
}
