/**
 * Deploy-throw classification: turns a deployManifest throw into barney's
 * registry/progress/ToolResult. See `handleDeployManifestError` for the rules.
 */

import { getLease, LeaseState } from '../../api/billing';
import { getLeaseProvision, getLeaseLogs, type FredLeaseStatus } from '../../api/fred';
import { asLeaseUuid, ManifestMCPError, ManifestMCPErrorCode } from '@manifest-network/manifest-sdk';
import { TerminalChainStateError, describeFredFailure } from '@manifest-network/manifest-sdk/deploy';
import { logError } from '../../utils/errors';
import { sanitizeForDisplay } from '../../utils/sanitizeText';
import type { ToolResult, ToolExecutorOptions, SigningContext } from './types';
import { failureText } from './helpers';
import { nextStepFor } from './failureGuidance';
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
  signing: SigningContext | undefined,
  appName: string
): Promise<string | null> {
  if (!signing) return null;

  try {
    const authToken = await signing.authTokens.getAuthToken(asLeaseUuid(leaseUuid));

    const parts: string[] = [];

    // Fetch provision status first — more structured than raw logs
    try {
      const provision = await getLeaseProvision(providerUrl, leaseUuid, authToken);
      // fred v0.13.0 dropped `last_error` for the curated `reason`/`message`
      // pair — read neither directly; `describeFredFailure` covers both eras.
      if (describeFredFailure(provision)) {
        const detail = failureText(provision, 'no detail reported');
        parts.push(`Provision error (fail_count=${provision.fail_count}): ${detail}`);
        // Via barney's remapper, never the SDK's `guidanceFor` — see
        // failureGuidance.ts. `reason` is an OPEN set: an unknown value yields
        // undefined here and is still relayed verbatim above, never rejected.
        const nextStep = nextStepFor(provision.reason, appName);
        if (nextStep) parts.push(nextStep);
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

// ---------------------------------------------------------------------------
// Structured deploy-throw discriminants (SDK 0.21)
// ---------------------------------------------------------------------------

/**
 * Fields `deployManifest` stamps on a post-lease throw
 * (packages/fred/src/tools/deployManifest.ts, both `throw` sites). Untyped, so
 * every read below is guarded rather than cast — a build that omits one must
 * degrade to the neutral wording, not throw.
 */
type DeployThrowDetails = Record<string, unknown> | undefined;

/** Narrow read of a string-valued discriminant. */
function detailString(details: DeployThrowDetails, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Did the deploy end WITHOUT the provider ever giving a verdict? Keyed off the
 * details FLAG, not the error code — a cancel mid-poll carries the flag but is
 * coded `OPERATION_CANCELLED`. The code is checked too, belt and braces.
 */
function isReadinessUnconfirmed(error: unknown, details: DeployThrowDetails): boolean {
  return (
    details?.readiness_unconfirmed === true ||
    (error instanceof ManifestMCPError && error.code === ManifestMCPErrorCode.DEPLOY_READINESS_UNCONFIRMED)
  );
}

/** Human sentence for WHY readiness was never confirmed. `poll_reason` is an open set: unknown or absent → neutral default. */
function readinessUnconfirmedCause(details: DeployThrowDetails, cancelled: boolean): string {
  if (cancelled) return 'You cancelled the deploy before the provider confirmed the app was ready.';
  switch (detailString(details, 'poll_reason')) {
    case 'deadline':
      return 'The provider had not reported the app ready yet — a cold image pull alone can take 5 minutes.';
    case 'provider_unreachable':
      return "The provider's status endpoint was unreachable from your browser.";
    default:
      return 'We stopped waiting before the provider reported the app ready.';
  }
}

/**
 * barney's copy for a readiness-unconfirmed deploy. Deliberately NOT the SDK's
 * raw message, which names `close_lease`, `wait_for_app_ready` and
 * `app_status({ lease_uuid })` — tools barney lacks, one destructive. "Never
 * found out" is not "failed", so nothing here suggests tearing the lease down.
 */
function readinessUnconfirmedMessage(name: string, details: DeployThrowDetails, cancelled: boolean): string {
  const parts = [
    `App "${name}" may still be starting. ${readinessUnconfirmedCause(details, cancelled)}`,
    'The lease exists and the provider never reported a failure, so we never found out whether it came up — this is not a failed deployment.',
  ];
  const lastStatus = detailString(details, 'last_provision_status');
  if (lastStatus) {
    parts.push(`The provider last reported provision_status "${sanitizeForDisplay(lastStatus)}".`);
  }
  parts.push(`Check with app_status("${name}"). Only stop_app("${name}") if you have decided to abandon it.`);
  return parts.join(' ');
}

/** Steps whose failure means the provider holds NO manifest — a real failure
 *  however healthy the chain lease looks. `'poll'` is absent on purpose: it is
 *  the only step that may take the still-deploying outcome. */
const NO_MANIFEST_STEPS = new Set(['set_domain', 'upload']);

/** barney's own copy for a partial deploy that never got the manifest uploaded. */
function noManifestMessage(name: string, step: string | undefined, cancelled: boolean): string {
  const cause =
    step === 'set_domain'
      ? 'the custom domain could not be attached, so the manifest was never uploaded'
      : step === 'upload'
        ? 'the manifest never reached the provider'
        : 'the deploy stopped immediately after the lease was created';
  const lead = cancelled ? 'Deploy cancelled' : 'Deployment failed';
  return (
    `${lead}: ${cause}. The lease was created but the provider holds no manifest, ` +
    `so nothing is running and nothing will start. ` +
    `Release it with stop_app("${name}"), then deploy again.`
  );
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
 * Case 1 (no lease): create-lease rejected. Case 2 (leaseUuid present): the
 * error's structured discriminants decide, falling through to the getLease
 * chain-check only when it carries none — keyed off `leaseUuid`, not the error
 * type, so an unexpected throw with a lease still resolves via chain state.
 * Case 3 (TerminalChainStateError): straight failed, no chain-check.
 *
 * Discriminants come first because the chain lease is ACTIVE for the whole
 * provisioning window by construction: the chain check answers 'running' alike
 * for a poll deadline, an unreachable provider, a user cancel and an upload that
 * never landed. Only `error.details` tells them apart.
 */
export async function handleDeployManifestError(
  error: unknown,
  ctx: DeployErrorContext,
): Promise<ToolResult> {
  const { name, leaseUuid, providerUrl, address, signing, appRegistry, onProgress } = ctx;

  // Case 3: chain-terminal — definitively failed, no chain re-check.
  if (error instanceof TerminalChainStateError) {
    // Both observations, because this throw carries both: the poll's chain check
    // saw the lease leave the tenant's live set, and nothing will ever provision
    // against a terminal lease. Do NOT drop `provisionState` — chain-absent alone
    // derives 'stopped', the one status `app_diagnostics`/`app_releases` refuse.
    if (leaseUuid) {
      appRegistry.updateApp(address, leaseUuid, { chainState: 'absent', provisionState: 'failed' });
    }
    onProgress?.({ phase: 'failed', detail: error.message });
    return { success: false, error: `Deployment failed: ${error.message}` };
  }

  // Case 2: post-lease throw.
  if (leaseUuid) {
    const errMessage = error instanceof Error ? error.message : String(error);
    const details: DeployThrowDetails = error instanceof ManifestMCPError ? error.details : undefined;
    const cancelled = error instanceof ManifestMCPError && error.code === ManifestMCPErrorCode.OPERATION_CANCELLED;

    // 2a: readiness never confirmed — NOT a failure (the lease is live and the provider never reported a failed
    // provision_status), so no URL and no AppCard. Unconditional: a chain re-read could only answer ACTIVE.
    if (isReadinessUnconfirmed(error, details)) {
      // The SDK's own prose goes to the log only — see readinessUnconfirmedMessage.
      logError('deployError.readinessUnconfirmed', error);
      // `provisionState: 'unconfirmed'`, not `status: 'deploying'`: the chain lease is ACTIVE throughout provisioning,
      // so a plain status is promoted back to 'running' by the next `reconcileWithChain` tick.
      appRegistry.updateApp(address, leaseUuid, { provisionState: 'unconfirmed' });
      const message = readinessUnconfirmedMessage(name, details, cancelled);
      // 'failed' is the ProgressCard's only terminal phase besides 'ready' — without one the card spins on 'provisioning' forever.
      onProgress?.({ phase: 'failed', detail: readinessUnconfirmedCause(details, cancelled) });
      return { success: true, data: { message, name, status: 'deploying' } };
    }

    // 2b: the deploy stopped BEFORE the manifest reached the provider — nothing will start, whatever the chain says.
    // `'poll'` is excluded on purpose: there the provider DID answer, which 2c handles (with diagnostics).
    const partial = details?.partial === true;
    const failedStep = detailString(details, 'failedStep');
    const noManifestUploaded =
      partial &&
      ((failedStep !== undefined && NO_MANIFEST_STEPS.has(failedStep)) ||
        // An absent step means the first `throwIfAborted()` fired, before the
        // set_domain/upload assignments. Gated on `cancelled` so a build that
        // omits the step for another reason falls through to the chain check.
        (failedStep === undefined && cancelled));
    if (noManifestUploaded) {
      logError('deployError.partialDeploy', error);
      // Durable, and true of the cancelled variant too: recording it stops the next reconcile calling this app 'running' off the ACTIVE lease.
      appRegistry.updateApp(address, leaseUuid, { provisionState: 'failed' });
      const message = noManifestMessage(name, failedStep, cancelled);
      onProgress?.({ phase: 'failed', detail: message });
      return { success: false, error: message };
    }

    // 2c: a provider verdict at the poll step — confirmed failed, no chain re-check (the lease is ACTIVE by construction and would read 'running').
    if (partial && failedStep === 'poll') {
      logError('deployError.pollVerdict', error);
      appRegistry.updateApp(address, leaseUuid, { provisionState: 'failed' });
      const diagnostics = providerUrl ? await fetchFailureLogs(providerUrl, leaseUuid, address, signing, name) : null;
      const lead = 'Deployment failed: the provider reported the deployment as failed.';
      onProgress?.({ phase: 'failed', detail: 'The provider reported the deployment as failed.' });
      return { success: false, error: diagnostics ? `${lead}\n\n${diagnostics}` : lead };
    }

    // 2d: no structured discriminant — fall back to chain truth. 2a/2b/2c claim
    // every `partial: true` throw, which keeps `errMessage` below from relaying
    // the SDK's prose; a new `failedStep` needs its own arm, not this branch.
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
      // Chain observation only — no `provisionState`: the deploy THREW, so the
      // provider never confirmed readiness and a chain read may not claim it.
      appRegistry.updateApp(address, leaseUuid, {
        chainState: 'active',
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
      // No observation on purpose: 'deploying' collapses LEASE_STATE_PENDING and
      // the unspecified states, so we cannot say what the chain reported.
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
    // verdict === 'failed'. No observation either: this conflates lease-terminal,
    // lease-absent and `getLease` unavailable (it answers 'failed' on a caught
    // error), and we cannot tell them apart.
    appRegistry.updateApp(address, leaseUuid, { status: 'failed' });
    onProgress?.({ phase: 'failed', detail: errMessage });
    const diagnostics = cancelled || !providerUrl
      ? null
      : await fetchFailureLogs(providerUrl, leaseUuid, address, signing, name);
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
