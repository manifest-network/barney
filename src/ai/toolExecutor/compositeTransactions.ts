/**
 * Composite transaction tool executors.
 * These return requiresConfirmation first, then execute after user approval.
 */

import type { CosmosClientManager, ManifestDeploySpec, DeployResult, TxCtx } from '@manifest-network/manifest-sdk';
import {
  asFqdn,
  asLeaseUuid,
  asSkuUuid,
  asProviderUuid,
  noopLogger,
} from '@manifest-network/manifest-sdk';
import { ManifestMCPError, ManifestMCPErrorCode } from '@manifest-network/manifest-sdk';
import { cosmosTx } from '@manifest-network/manifest-sdk/chain';
import { getCreditAccount, getLease, LeaseState } from '../../api/billing';
import { getProviders } from '../../api/sku';
import { resolveSizeOrCheapest } from '../../api/skuTiers';
import { ProviderApiError } from '../../api/provider-api';
import { getLeaseProvision, type FredLeaseStatus } from '../../api/fred';
import { DENOMS } from '../../api/config';
import { fromBaseUnits, parseJsonStringArray } from '../../utils/format';
import { logError, normalizeErrorPunctuation } from '../../utils/errors';
import { withTimeout } from '../../api/utils';
import { AI_DEPLOY_PROVISION_TIMEOUT_MS, AI_LEASE_WAIT_TIMEOUT_MS, FRED_POLL_INTERVAL_MS } from '../../config/constants';
import { deriveUrlFromConnection, failureText } from './helpers';
import { normalizeFqdn, resolveExpectedCnameTarget } from '../../utils/connection';
import { getLeaseItemsForLease } from '../../api/leaseItems';
import { queryLeaseByCustomDomain } from '../../api/leaseByCustomDomain';
import { getDomainForService } from '../../api/leaseDomains';
import { validateAll, apexRecordKindLabel } from '../../utils/customDomainValidation';
import { validateAppName, sanitizeManifestForStorage, type AppEntry, type ProvisionState } from '../../registry/appRegistry';
import { buildStackManifest, mergeManifest, resolveGeneratedPassword } from '../manifest';
import { sha256, toHex, generatePassword } from '../../utils/hash';
import type { ToolResult, ToolExecutorOptions, PayloadAttachment } from './types';
import type { SigningContext } from './types';
import { runBatchWithConcurrency, summarizeBatchResult } from './batchRunner';
import { deployManifest, stopApp, setItemCustomDomain as monoSetItemCustomDomain, waitForLeaseStatus, isLeaseFailureTerminal, restartApp, updateApp, describeFredFailure, isKnownFailureReason, type FredAuthCtx, type DeployCallOptions, type StopAppResult, type TerminalChainState } from '@manifest-network/manifest-sdk/deploy';
import { nextStepFor } from './failureGuidance';
import { isUnsettledProvisionStatus } from './provisionStatus';
import { buildBarneyCtx } from './capabilityCtx';
import { browserEventTransport } from '../../api/eventTransport';
import {
  buildImageManifestFromArgs,
  buildPayloadFromManifest,
  deriveAppName,
  extractServiceNamesFromPayload,
  parseAndValidateStackServices,
  validateInternalServiceNames,
  validateManifestEnvNames,
} from './deployArgs';
import { resolveAppUrl } from './deployUrl';
import { handleDeployManifestError } from './deployError';
import {
  batchPlanToEntries,
  planBatchDeploy,
  verifyBatchDeployPlanIntegrity,
  type BatchDeployEntry,
  type BatchDeployPlanEntry,
} from './batchDeployPlan';

// Re-export the public deploy-helper symbols so existing consumers/tests that
// import them from './compositeTransactions' keep working after the ENG-576 split.
export { buildPayloadFromManifest, deriveAppName, extractServiceNamesFromPayload, parseAndValidateStackServices } from './deployArgs';
export { extractUrlFromFredStatus } from './deployUrl';
export { classifyLeaseChainState, handleDeployManifestError } from './deployError';
export type { BatchDeployEntry, BatchDeployPlan, BatchDeployPlanEntry } from './batchDeployPlan';

/**
 * Was the thrown thing ITSELF an abort?
 *
 * Deliberately NOT `signal?.aborted`: any new user message aborts the shared
 * chat controller, so a genuine `ProviderApiError(500)` landing while the user
 * types would otherwise be reported as "cancelled before the provider was
 * asked" and never recorded. Two arms because `throwIfAborted()` raises a
 * `DOMException`, but some polyfills raise a plain `Error` with that name.
 */
function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Read the SDK's structured transaction-cancellation verdict without relying
 * solely on `instanceof` (duplicate package copies can break it). `true` means
 * broadcast was started and the chain outcome is unknown; `false` proves that
 * nothing was submitted.
 */
function cancelledTransactionWasSent(error: unknown): boolean | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; details?: { sent?: unknown } };
  if (candidate.code !== ManifestMCPErrorCode.OPERATION_CANCELLED) return undefined;
  return typeof candidate.details?.sent === 'boolean' ? candidate.details.sent : undefined;
}

function isTransactionCancellation(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === ManifestMCPErrorCode.OPERATION_CANCELLED;
}

/**
 * The provisioning OBSERVATION carried by a `waitForLeaseStatus` REJECTION.
 *
 * A poll timeout is SILENCE, not a verdict — the same `'poll'` vs
 * `'poll_verdict'` split `deployError.ts` draws. A provider VERDICT never
 * reaches here: `waitForLeaseStatus` RESOLVES at any terminal state (the caller
 * classifies that with `isLeaseFailureTerminal`), so every rejection is a
 * non-verdict — deadline, setup failure, status-read error, abort. Keep the
 * `'poll_verdict'` arm on `'failed'` in case a future build routes a real
 * verdict out through the rejection. Contract source: manifest-mcp-fred
 * `dist/tools/waitForLeaseStatus.js`.
 *
 * `isTransientProviderError` is deliberately not consulted — "worth retrying"
 * is orthogonal to "did the workload come up".
 */
function provisionObservationFromWaitError(error: unknown): ProvisionState {
  if (ProviderApiError.isProviderApiError(error) && error.kind === 'poll_verdict') return 'failed';
  return 'unconfirmed';
}

/**
 * Parse a multi-app app_name value into resolved AppEntry[].
 * Supports "all" (all matching apps), comma-separated names, or a single name.
 * `filter` selects which apps are eligible (e.g. running-only for restart).
 */
type ResolveResult =
  | { mode: 'single'; name: string }
  | { mode: 'multi'; apps: AppEntry[]; skipped?: string[] }
  | { mode: 'error'; error: string };

function resolveMultiAppNames(
  name: string,
  address: string,
  appRegistry: ToolExecutorOptions['appRegistry'] & object,
  filter: (a: AppEntry) => boolean,
  verb: string
): ResolveResult {
  const trimmed = name.trim();
  const allApps = appRegistry.getApps(address);
  const eligible = allApps.filter(filter);

  if (trimmed.toLowerCase() === 'all') {
    if (eligible.length === 0) return { mode: 'error', error: `No eligible apps to ${verb}.` };
    return { mode: 'multi', apps: eligible };
  }

  // Comma-separated names
  const names = trimmed.split(',').map((n) => n.trim()).filter(Boolean);
  if (names.length <= 1) return { mode: 'single', name: names[0] ?? trimmed };

  const resolved: AppEntry[] = [];
  const notFound: string[] = [];
  const notEligible: string[] = [];

  for (const n of names) {
    const app = appRegistry.findApp(address, n);
    if (!app) {
      notFound.push(n);
    } else if (!filter(app)) {
      notEligible.push(app.name);
    } else {
      // Deduplicate (same app referenced multiple ways)
      if (!resolved.some((r) => r.leaseUuid === app.leaseUuid)) {
        resolved.push(app);
      }
    }
  }

  if (notFound.length > 0) {
    return { mode: 'error', error: `App${notFound.length > 1 ? 's' : ''} not found: ${notFound.join(', ')}` };
  }
  if (resolved.length === 0) {
    return { mode: 'error', error: `No eligible apps to ${verb}: ${notEligible.join(', ')}` };
  }
  return { mode: 'multi', apps: resolved, skipped: notEligible.length > 0 ? notEligible : undefined };
}

// ============================================================================
// deploy_app
// ============================================================================

/**
 * Assemble the FredAuthCtx deployManifest needs. `query` = read client's
 * ManifestQueryClient (backs resolveProviderUrl); `chain` = the SIGNING
 * clientManager (backs cosmosTx create-lease — never the read client's
 * query-only manager); `fetch` = providerFetch (DEV proxy / PROD SSRF);
 * `logger` = noopLogger; `providerAuth` = the single root-built minter.
 */
export async function buildFredAuthCtx(
  clientManager: CosmosClientManager,
  signing: SigningContext,
): Promise<FredAuthCtx> {
  // Delegates to the shared capability-ctx factory (Phase 3). Kept as a named
  // export for the existing deploy-path call sites; buildBarneyCtx additionally
  // sets allowLoopback and the optional `events` WS seam.
  return buildBarneyCtx(clientManager, signing);
}

/**
 * Pre-validation for deploy_app. Builds/validates the manifest from the tool
 * args (or attached payload) and returns a confirmation result
 * (`requiresConfirmation`) or an error; the broadcast happens later in
 * `executeConfirmedDeployApp`.
 */
export async function executeDeployApp(
  args: Record<string, unknown>,
  options: ToolExecutorOptions,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  // Stack-based deploy: build stack manifest from services param
  if (!payload && typeof args.services === 'string' && args.services) {
    if (args.image) {
      return { success: false, error: '"image" and "services" are mutually exclusive. Use "image" for single-service or "services" for multi-service stack.' };
    }

    const parsed = parseAndValidateStackServices(
      args.services as string, true, 'compositeTransactions.executeDeployApp.parseServices'
    );
    if ('error' in parsed) return { success: false, error: parsed.error };

    // Pre-generate a shared password for all auto-generated env vars in the stack.
    // This ensures cross-service credentials match (e.g., WORDPRESS_DB_PASSWORD matches MYSQL_PASSWORD).
    const sharedPassword = generatePassword();
    for (const svc of Object.values(parsed.services)) {
      if (svc.env) {
        for (const key of Object.keys(svc.env)) {
          svc.env[key] = resolveGeneratedPassword(svc.env[key], () => sharedPassword);
        }
      }
    }

    let manifestResult;
    try {
      manifestResult = await buildStackManifest({ services: parsed.services });
    } catch (error) {
      logError('compositeTransactions.executeDeployApp.buildStackManifest', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to build stack manifest' };
    }

    payload = manifestResult.payload;
    if (!args.app_name) {
      args.app_name = manifestResult.derivedAppName;
    }
    args._generatedManifest = manifestResult.json;
    args._serviceNames = parsed.serviceNames;
  }

  // Image-based deploy: build manifest from args when no file is attached
  if (!payload && args.image) {
    const built = await buildImageManifestFromArgs(args, {
      applyEnvDefaults: true,
      applyHealthCheckDefault: true,
      deriveAppName: true,
      errorContext: 'executeDeployApp',
    });
    if ('error' in built) return { success: false, error: built.error };
    payload = built.payload;
  }

  if (!payload) {
    return { success: false, error: 'No file attached and no image specified. Attach a manifest file or specify a Docker image (e.g. deploy_app(image="redis:8.4")).' };
  }

  // File-attached manifests must be valid JSON — the deploy SDK JSON.parses
  // + validates the manifest string (§3.9). Non-JSON (e.g. YAML) is rejected
  // here so the user gets a clear signal before any TX.
  if (!args._generatedManifest) {
    const json = new TextDecoder().decode(payload.bytes);
    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(json);
    } catch {
      return { success: false, error: 'Manifest must be valid JSON — convert YAML/other formats to JSON first.' };
    }
    // Run the blocked-env-name guard on the uploaded env at parse time (before
    // any merge/hash) — the image-arg/stack-string paths validate elsewhere, so
    // a file-attached manifest would otherwise skip the blocklist (S3).
    const envError = validateManifestEnvNames(parsedManifest);
    if (envError) return { success: false, error: envError };
    args._generatedManifest = json;
  }

  // Extract service names from the file-uploaded stack manifest (JSON only —
  // non-JSON content was already rejected above).
  if (!args._serviceNames) {
    const names = extractServiceNamesFromPayload(payload.bytes);
    if (names.length > 0) {
      args._serviceNames = names;
    }
  }

  // Resolve name
  let name = args.app_name as string | undefined;
  if (!name && payload.filename) {
    name = deriveAppName(payload.filename);
  }
  if (!name) {
    name = `app-${Date.now().toString(36)}`;
  }

  // Validate name — auto-suffix on collision with running/deploying apps
  let nameError = validateAppName(name, address);
  if (nameError) {
    const baseName = name;
    let suffix = 2;
    while (nameError && suffix <= 99) {
      const candidate = `${baseName}-${suffix}`.slice(0, 32);
      nameError = validateAppName(candidate, address);
      if (!nameError) {
        name = candidate;
      }
      suffix++;
    }
    if (nameError) {
      return { success: false, error: nameError };
    }
  }

  // Resolve size from the AI store's resolved tier list. No chain round-trip
  // needed — the tier list already has SKU UUID, provider UUID, and normalized
  // $/hour price baked in. An omitted or unavailable size falls back to the
  // cheapest tier (resolveSizeOrCheapest); an empty catalog is the only hard
  // failure. The ConfirmationCard calls the same resolver so its price/specs
  // row and any substitution note match exactly what deploys here.
  const { tiers } = options;
  const resolution = resolveSizeOrCheapest(args.size as string | undefined, tiers);
  if (!resolution) {
    return { success: false, error: 'Tier catalog unavailable — try again in a moment.' };
  }
  const matched = resolution.tier;
  const size = matched.skuName;  // canonical SKU name
  const skuUuid = matched.skuUuid;

  // Find provider — still need apiUrl, which isn't in ResolvedSkuTier.
  let providers;
  try {
    providers = await withTimeout(getProviders(true), undefined, 'Fetch providers');
  } catch (error) {
    logError('compositeTransactions.deploy.fetchProviders', error);
    return { success: false, error: 'Failed to fetch providers. Please try again.' };
  }

  const provider = providers.find((p) => p.uuid === matched.providerUuid);

  if (!provider || !provider.apiUrl) {
    return { success: false, error: 'No available provider found for this tier.' };
  }

  // Pricing is normalized to $/hour at the source (`resolveSkuTiers`).
  // Pass-11 invariant: every resolved tier has `basePrice`, so
  // `pricePerHour === 0` is a genuinely-free tier (`basePrice.amount === '0'`),
  // NOT a missing-price candidate. Format unconditionally so free tiers
  // surface "0.0000 .../hr" on the confirmation card instead of going blank
  // (billing-transparency — same category as pass 5).
  const skuHourlyCost = matched.pricePerHour;
  const priceDisplay = `${skuHourlyCost.toFixed(4)} ${matched.denomSymbol}/hr`;

  // Stack deploys multiply cost by service count
  const serviceNamesResult = validateInternalServiceNames(args._serviceNames, 'deploy_app');
  if (serviceNamesResult.error) {
    return { success: false, error: serviceNamesResult.error };
  }
  const serviceNames = serviceNamesResult.serviceNames;
  const serviceCount = serviceNames && serviceNames.length > 0 ? serviceNames.length : 1;

  // Check credits - verify user can afford at least 1 hour of this SKU
  let creditWarning = '';
  try {
    const creditAccount = await withTimeout(getCreditAccount(address), undefined, 'Credit check');
    if (creditAccount?.balances) {
      // Find PWR balance
      let credits = 0;
      for (const bal of creditAccount.balances) {
        if (bal.denom === DENOMS.PWR || bal.denom.includes('upwr')) {
          credits = fromBaseUnits(bal.amount, bal.denom);
          break;
        }
      }

      // Check if user can afford at least 1 hour (multiplied by service count for stacks)
      const totalHourlyCost = skuHourlyCost * serviceCount;
      if (totalHourlyCost > 0 && credits < totalHourlyCost) {
        return {
          success: false,
          error: `Insufficient credits. You have ${Math.round(credits * 100) / 100} credits but need at least ${Math.round(totalHourlyCost * 100) / 100} for 1 hour${serviceCount > 1 ? ` (${serviceCount} services)` : ''}. Selected: ${size} tier on ${provider.uuid} (${priceDisplay}). Use fund_credits to add more credits.`,
        };
      }

      // Warn if less than 24 hours of runway for this SKU
      if (totalHourlyCost > 0) {
        const hoursAffordable = credits / totalHourlyCost;
        if (hoursAffordable < 24) {
          creditWarning = ` Warning: only ~${Math.floor(hoursAffordable)}h of credits remaining at this rate.`;
        }
      }
    }
  } catch (error) {
    logError('compositeTransactions.executeDeployApp.creditCheck', error);
    creditWarning = ' Warning: could not verify credit balance — proceed with caution.';
  }

  const stackInfo = serviceCount > 1 ? ` (${serviceCount} services)` : '';
  // priceDisplay is always non-empty (pass-16 invariant) — no need for a
  // truthy guard around the ` (~…)` wrapper anymore.
  const priceInfo = ` (~${priceDisplay}${serviceCount > 1 ? ` × ${serviceCount}` : ''})`;

  // Optional custom domain: validate up front so the user gets fast feedback
  // before any TX. The set-domain TX will be broadcast in the confirmed-deploy
  // path, between create-lease and manifest upload.
  let customDomain = '';
  let customDomainServiceName = '';
  let customDomainWarning: string | undefined;
  if (typeof args.custom_domain === 'string' && args.custom_domain.trim() !== '') {
    customDomain = normalizeFqdn(args.custom_domain);
    const validation = await validateAll(customDomain);
    if (validation.error) return { success: false, error: validation.error };
    customDomainWarning = validation.warning;

    // Uniqueness pre-check, mirroring `executeSetCustomDomain`; without it, a
    // deploy can confirm and pay for a lease before the post-broadcast
    // MsgSetItemCustomDomain is chain-rejected as duplicate, leaving the user
    // charged for a non-functional deploy. Wrap in withTimeout to bound the
    // latency cost — consistent with the other LCD calls in this executor
    // (`compositeQueries.ts`, `billingParams.ts`).
    // On error/timeout: fall through, chain remains authoritative.
    // See PR #93 Copilot 3248436488.
    try {
      const existing = await withTimeout(
        queryLeaseByCustomDomain(customDomain),
        undefined,
        'queryLeaseByCustomDomain',
      );
      if (existing) {
        const heldByApp = appRegistry.getAppByLease(address, existing.leaseUuid);
        const friendly = heldByApp ? `"${heldByApp.name}"` : 'another lease';
        return {
          success: false,
          error: `"${customDomain}" is already attached to ${friendly}. Pick a different domain or detach it first.`,
        };
      }
    } catch (err) {
      logError('compositeTransactions.executeDeployApp.queryLeaseByCustomDomain', err);
      // Don't block — chain remains authoritative.
    }

    if (serviceNames && serviceNames.length > 1) {
      const explicit = typeof args.service_name === 'string' ? args.service_name.trim() : '';
      if (!explicit) {
        return {
          success: false,
          error: `"${name}" is a multi-service stack — pass service_name to attach the custom domain to one of: ${serviceNames.join(', ')}.`,
        };
      }
      if (!serviceNames.includes(explicit)) {
        return {
          success: false,
          error: `Service "${explicit}" not found in stack. Available: ${serviceNames.join(', ')}.`,
        };
      }
      customDomainServiceName = explicit;
    } else if (serviceNames && serviceNames.length === 1) {
      // Single-service stack — auto-select.
      customDomainServiceName = serviceNames[0];
    } else {
      // Image+port single-item legacy lease — chain wants serviceName=''.
      customDomainServiceName = '';
    }
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Deploy "${name}"${stackInfo} on ${size} tier${priceInfo}?${creditWarning}`,
    pendingAction: {
      toolName: 'deploy_app',
      args: {
        app_name: name,
        size,
        skuUuid,
        providerUuid: provider.uuid,
        providerUrl: provider.apiUrl,
        ...(args._generatedManifest ? { _generatedManifest: args._generatedManifest } : {}),
        ...(serviceNames && serviceNames.length > 0 ? { _serviceNames: serviceNames } : {}),
        ...(customDomain ? {
          customDomain,
          customDomainServiceName,
          ...(customDomainWarning ? { customDomainWarning } : {}),
        } : {}),
      },
    },
  };
}

/**
 * Execute deploy_app after user confirmation. Delegates the create-lease →
 * (set-domain) → upload → poll spine to the SDK's deployManifest primitive
 * (ENG-279 §3.2). barney keeps the plan phase, registry state machine,
 * progress UI, and URL shaping around it.
 */
export async function executeConfirmedDeployApp(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  const { address, appRegistry, signing, onProgress, signal } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  // Reconstruct payload from stored manifest JSON (image/stack deploy). This
  // strips MANIFEST_NOTICE_KEY, so payload.bytes are the byte-exact upload body.
  if (!payload && typeof args._generatedManifest === 'string') {
    payload = await buildPayloadFromManifest(args._generatedManifest);
  }
  if (!payload) return { success: false, error: 'Payload missing' };
  if (!signing) return { success: false, error: 'Wallet does not support message signing' };

  const name = args.app_name as string;
  const size = args.size as string;
  const skuUuid = args.skuUuid as string;
  const providerUuid = args.providerUuid as string;
  const providerUrl = args.providerUrl as string;

  // The exact JSON deployManifest will JSON.parse + validateManifest + hash
  // (its meta_hash must match the uploaded body — buildPayloadFromManifest
  // already stripped _notice, §3.9).
  const manifestJson = new TextDecoder().decode(payload.bytes);

  // Custom domain: pre-validated in the plan phase. Attach IN-deploy via the
  // spec (deployManifest sets it before upload — Traefik-safe). barney no
  // longer calls monoSetItemCustomDomain itself (would double-set, §3.10).
  const customDomainArg = typeof args.customDomain === 'string' ? args.customDomain : '';
  const customDomainServiceName = typeof args.customDomainServiceName === 'string' ? args.customDomainServiceName : '';

  const spec: ManifestDeploySpec = {
    manifest: manifestJson,
    sku: {
      kind: 'resolved',
      skuUuid: asSkuUuid(skuUuid),
      providerUuid: asProviderUuid(providerUuid),
    },
    ...(customDomainArg !== '' ? { customDomain: customDomainArg } : {}),
    // OMIT serviceName when empty — deployManifest throws if it is set on a
    // single-service lease (§3.10). Only meaningful with a customDomain.
    ...(customDomainArg !== '' && customDomainServiceName !== ''
      ? { serviceName: customDomainServiceName }
      : {}),
  };

  onProgress?.({ phase: 'creating_lease', detail: 'Creating lease on-chain...' });

  // Captured from onLeaseCreated (runs OUTSIDE deployManifest's try/catch); the
  // error handler + checkChainState both read these.
  let capturedLeaseUuid: string | undefined;
  let capturedProviderUrl: string | undefined;

  const callOptions: DeployCallOptions = {
    onLeaseCreated: (leaseUuid, url) => {
      capturedLeaseUuid = leaseUuid;
      capturedProviderUrl = url;
      onProgress?.({ phase: 'uploading', detail: 'Uploading manifest to provider...' });
      try {
        appRegistry.addApp(address, {
          // No observation yet — the create-lease TX landed, but nothing has
          // been read from chain or provider. `status: 'deploying'` is the seed
          // for an observation-free entry; later writers outrank it.
          name,
          leaseUuid,
          size,
          providerUuid,
          providerUrl: url,
          createdAt: Date.now(),
          status: 'deploying',
          manifest: sanitizeManifestForStorage(manifestJson),
        });
      } catch (error) {
        // Lease already on-chain — log, don't abort.
        logError('compositeTransactions.executeConfirmedDeployApp.addApp', error);
      }
    },
    abortSignal: signal, // top-level, NOT inside pollOptions
    pollOptions: {
      intervalMs: FRED_POLL_INTERVAL_MS,
      timeoutMs: AI_DEPLOY_PROVISION_TIMEOUT_MS,
      onProgress: (status) => {
        onProgress?.({ phase: 'provisioning', detail: status.phase || 'Provisioning...', fredStatus: status });
      },
      // null-on-404 / NEVER-throw: the SDK poll PROPAGATES checkChainState
      // errors (§3.8). Early rejected/closed detection only.
      checkChainState: async (): Promise<TerminalChainState | null> => {
        try {
          const lease = capturedLeaseUuid ? await getLease(capturedLeaseUuid) : null;
          if (!lease) return null;
          if (lease.state === LeaseState.LEASE_STATE_CLOSED) return { state: 'closed' };
          if (lease.state === LeaseState.LEASE_STATE_REJECTED) return { state: 'rejected' };
          if (lease.state === LeaseState.LEASE_STATE_EXPIRED) return { state: 'expired' };
          return null;
        } catch (error) {
          logError('compositeTransactions.executeConfirmedDeployApp.checkChainState', error);
          return null;
        }
      },
    },
  };

  const deployErrorContext = () => ({
    name,
    leaseUuid: capturedLeaseUuid,
    providerUrl: capturedProviderUrl ?? providerUrl,
    address,
    signing,
    appRegistry,
    onProgress,
  });
  let ctx: Awaited<ReturnType<typeof buildFredAuthCtx>>;
  try {
    ctx = await buildFredAuthCtx(clientManager, signing);
  } catch (error) {
    return await handleDeployManifestError(error, deployErrorContext());
  }

  options.assertAuthorization?.();
  let result: DeployResult;
  try {
    result = await deployManifest(ctx, spec, callOptions);
  } catch (error) {
    return await handleDeployManifestError(error, deployErrorContext());
  }

  const leaseUuid = result.lease_uuid;

  // URL shaping — never DeployResult.url (regresses stacks/FQDN, §3.6). Prefer
  // the no-round-trip shaper; fall back to resolveAppUrl only when connection
  // is absent (the degraded branch).
  const shaped = result.connection ? deriveUrlFromConnection(result.connection) : undefined;
  const { url: connectionUrl, connection } = shaped
    ?? await resolveAppUrl(
      result.provider_url,
      leaseUuid,
      { state: result.state } as FredLeaseStatus,
      address,
      signing,
      'compositeTransactions.executeConfirmedDeployApp',
    );

  // Custom-domain attach outcome comes from deployManifest's result (it set the
  // domain internally). Cache it so the DNS polling driver + sidebar dot see it.
  const attachedDomain = typeof result.custom_domain === 'string' && result.custom_domain !== ''
    ? result.custom_domain
    : undefined;
  const attachedServiceName = typeof result.service_name === 'string' ? result.service_name : '';

  let customDomainsUpdate: object = {};
  if (attachedDomain) {
    const prior = appRegistry.getAppByLease(address, leaseUuid)?.customDomains ?? [];
    const others = prior.filter((d) => d.serviceName !== attachedServiceName);
    customDomainsUpdate = {
      customDomains: [...others, { serviceName: attachedServiceName, customDomain: attachedDomain }],
    };
  }

  // Record the two observations, not a summary: `deployManifest` only RESOLVES
  // once its readiness poll saw the lease ACTIVE on chain AND `provision_status`
  // in `PROVISION_SUCCESS` (exactly `ready`). `status` is derived from them.
  appRegistry.updateApp(address, leaseUuid, {
    chainState: 'active',
    provisionState: 'confirmed',
    url: connectionUrl,
    connection: connection ? JSON.parse(JSON.stringify(connection)) : undefined,
    ...customDomainsUpdate,
  });
  onProgress?.({ phase: 'ready', detail: 'App is live!' });

  const expectedCnameTarget = attachedDomain
    ? resolveExpectedCnameTarget(connection, attachedServiceName)
    : undefined;
  const isApexAttached = typeof args.customDomainWarning === 'string' && args.customDomainWarning.length > 0;
  const recordKind = isApexAttached
    ? `an ${apexRecordKindLabel(true)} record (apex domains cannot use CNAME)`
    : `a ${apexRecordKindLabel(false)}`;

  const message = attachedDomain
    ? `App "${name}" is live. Custom domain "${attachedDomain}" attached — add ${recordKind} at your registrar pointing at ${expectedCnameTarget ?? '<provider FQDN>'}.`
    : `App "${name}" is live!`;

  const displayCard = {
    type: 'app' as const,
    data: {
      name,
      url: connectionUrl,
      status: 'running',
      connection: connection ? JSON.parse(JSON.stringify(connection)) : undefined,
      ...(attachedDomain
        ? {
            customDomain: {
              fqdn: attachedDomain,
              leaseUuid,
              serviceName: attachedServiceName,
              expectedCnameTarget,
              isApex: isApexAttached,
            },
          }
        : {}),
    },
  };

  return {
    success: true,
    data: {
      message,
      name,
      url: connectionUrl,
      status: 'running',
      ...(attachedDomain
        ? {
            custom_domain: attachedDomain,
            service_name: attachedServiceName,
            expected_cname_target: expectedCnameTarget,
            is_apex: isApexAttached,
          }
        : {}),
    },
    displayCard,
  };
}

// ============================================================================
// batch_deploy
// ============================================================================

/** Plan every batch entry through the canonical consent/affordability path. */
export async function executeBatchDeploy(
  entries: BatchDeployEntry[],
  options: ToolExecutorOptions,
  size?: string
): Promise<ToolResult> {
  const drafts = entries.map((entry) => ({ ...entry, size: entry.size ?? size }));
  const result = await planBatchDeploy(drafts, options);
  if (!result.success) return result;
  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: result.confirmationMessage,
    pendingAction: {
      toolName: 'batch_deploy',
      args: { plan: result.plan },
    },
  };
}

/**
 * Execute batch deploy after user confirmation.
 *
 * Runs per-app deploy pipelines concurrently (bounded by AI_BATCH_DEPLOY_CONCURRENCY)
 * by delegating each entry to the SDK `deployManifest` primitive (mirrors the
 * single-deploy path). Serialization of wallet operations is already provided by
 * CosmosClientManager.withBroadcastLock (create-lease broadcasts) and the
 * mutex-wrapped signArbitrary inside providerAuth (ADR-036 token mints) — so
 * deployManifest runs DIRECTLY under runBatchWithConcurrency, never inside
 * a caller-side signing mutex / sign-lock (that would deadlock, see §3.11 below).
 */
export async function executeConfirmedBatchDeploy(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry, signing, onProgress, signal } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };
  if (!signing) return { success: false, error: 'Wallet does not support message signing' };

  const integrity = await verifyBatchDeployPlanIntegrity(args.plan);
  if (!integrity.success) return { success: false, error: integrity.error };

  // Re-run the same planner with a fresh chain SKU catalog and aggregate
  // balance. Any changed price/provider/name/payload invalidates the consent
  // artifact before the first non-idempotent call.
  const refreshed = await planBatchDeploy(
    batchPlanToEntries(integrity.plan),
    options,
    { refreshPrices: true },
  );
  if (!refreshed.success) return refreshed;
  if (refreshed.plan.planHash !== integrity.plan.planHash) {
    return {
      success: false,
      error: 'The batch deployment plan changed after approval (price, provider, name, or payload). No transaction was submitted; review a new plan and confirm again.',
    };
  }
  const entries: BatchDeployPlanEntry[] = refreshed.plan.entries;

  const batchEntries = entries.map((e) => ({ ...e, name: e.app_name }));

  // getReadClient is a cached singleton, so the FredAuthCtx is assembled once
  // and shared across every entry (correctness-neutral, avoids redundant awaits).
  const ctx = await buildFredAuthCtx(clientManager, signing);

  const { succeeded, failed, unconfirmed, cancelled, batchProgress } = await runBatchWithConcurrency({
    entries: batchEntries,
    intermediatePhases: ['provisioning', 'uploading', 'creating_lease'],
    initialPhase: 'creating_lease',
    signal,
    onProgress,
    executeOne: async (entry, _i, updateProgress) => {
      const name = entry.app_name;

      const manifest = entry.manifest;

      const customDomainArg =
        typeof entry.customDomain === 'string' ? entry.customDomain : '';
      const customDomainServiceName =
        typeof entry.customDomainServiceName === 'string' ? entry.customDomainServiceName : '';

      const spec: ManifestDeploySpec = {
        manifest,
        sku: {
          kind: 'resolved',
          skuUuid: asSkuUuid(entry.skuUuid),
          providerUuid: asProviderUuid(entry.providerUuid),
        },
        // Attach in-deploy: deployManifest sets the domain BEFORE upload (Traefik-safe).
        ...(customDomainArg !== '' ? { customDomain: customDomainArg } : {}),
        // OMIT serviceName when empty — the SDK throws on serviceName for a
        // single-service lease. Only meaningful alongside a customDomain.
        ...(customDomainArg !== '' && customDomainServiceName !== ''
          ? { serviceName: customDomainServiceName }
          : {}),
      };

      let capturedLeaseUuid: string | undefined;
      let capturedProviderUrl: string | undefined;
      const callOptions: DeployCallOptions = {
        // Use the providerUrl deployManifest resolved (its 2nd arg), mirroring
        // `executeConfirmedDeployApp`'s own `onLeaseCreated` — NOT entry.providerUrl — so the
        // registry records the exact provider the SDK used for upload/poll.
        onLeaseCreated: (leaseUuid, providerUrl) => {
          capturedLeaseUuid = leaseUuid;
          capturedProviderUrl = providerUrl;
          updateProgress('uploading', 'Uploading manifest...');
          try {
            // Observation-free seed entry — see the single-deploy addApp above.
            appRegistry.addApp(address, {
              name,
              leaseUuid,
              size: entry.size,
              providerUuid: entry.providerUuid,
              providerUrl,
              createdAt: Date.now(),
              status: 'deploying',
              manifest: sanitizeManifestForStorage(manifest),
            });
          } catch (error) {
            logError('compositeTransactions.executeConfirmedBatchDeploy.addApp', error);
          }
        },
        abortSignal: signal,
        pollOptions: {
          intervalMs: FRED_POLL_INTERVAL_MS,
          timeoutMs: AI_DEPLOY_PROVISION_TIMEOUT_MS,
          onProgress: (status) => {
            updateProgress('provisioning', status.phase || 'Provisioning...');
          },
          // Null-on-404 / never-throw: the SDK poll re-raises whatever this
          // returns or throws, so it must only surface terminal states.
          checkChainState: async (): Promise<TerminalChainState | null> => {
            try {
              const lease = capturedLeaseUuid ? await getLease(capturedLeaseUuid) : null;
              if (!lease) return null;
              if (lease.state === LeaseState.LEASE_STATE_CLOSED) return { state: 'closed' };
              if (lease.state === LeaseState.LEASE_STATE_REJECTED) return { state: 'rejected' };
              if (lease.state === LeaseState.LEASE_STATE_EXPIRED) return { state: 'expired' };
              return null;
            } catch (error) {
              logError('compositeTransactions.executeConfirmedBatchDeploy.checkChainState', error);
              return null;
            }
          },
        },
      };

      updateProgress('creating_lease', 'Creating lease on-chain...');

      // §3.11: call deployManifest DIRECTLY — NEVER wrap it in a caller-side sign-lock.
      // Such a lock holds the mutex until the wrapped fn resolves; deployManifest
      // internally mints ADR-036 tokens via the SAME mutex-wrapped signArbitrary,
      // so a wrap would await a lock it already holds -> deadlock (non-reentrant).
      // Broadcasts are already serialized by CosmosClientManager.withBroadcastLock
      // and each token mint by the signing mutex inside providerAuth.
      let result: DeployResult;
      try {
        options.assertAuthorization?.();
        signal?.throwIfAborted();
      } catch (error) {
        logError('compositeTransactions.executeConfirmedBatchDeploy.guard', error);
        updateProgress('failed', 'Cancelled before deployment was submitted');
        return { name, outcome: 'cancelled' as const };
      }
      try {
        result = await deployManifest(ctx, spec, callOptions);
      } catch (error) {
        const errResult = await handleDeployManifestError(error, {
          name,
          leaseUuid: capturedLeaseUuid,
          providerUrl: capturedProviderUrl ?? entry.providerUrl,
          address,
          signing,
          appRegistry,
          onProgress: (p) => updateProgress(p.phase, p.detail),
        });
        if (errResult.success) {
          // Branch on the VERDICT, not the boolean: handleDeployManifestError
          // answers success:true both for 'running' (came up despite the throw)
          // and 'deploying' (readiness never confirmed). Counting the latter in
          // `succeeded` claims apps deployed that the provider never confirmed.
          const data = errResult.data as { url?: string; status?: string; message?: string } | undefined;
          if (data?.status === 'deploying') {
            // Carry handleDeployManifestError's copy through — it is the only
            // place that knows WHY we never found out, and it is what tells the
            // model to check app_status rather than tear the lease down.
            return { name, outcome: 'unconfirmed' as const, detail: data.message };
          }
          // running-on-throw verdict: propagate the URL resolved in
          // handleDeployManifestError so the batch entry carries a link
          // instead of a bare name.
          return { name, url: data?.url };
        }
        updateProgress('failed', errResult.error ?? 'Deployment failed');
        return null;
      }

      const shaped = result.connection ? deriveUrlFromConnection(result.connection) : undefined;
      const { url: connectionUrl, connection } = shaped
        ?? await resolveAppUrl(
          result.provider_url,
          result.lease_uuid,
          { state: result.state } as FredLeaseStatus,
          address,
          signing,
          'executeConfirmedBatchDeploy',
        );

      // Same two observations as the single-deploy success path.
      appRegistry.updateApp(address, result.lease_uuid, {
        chainState: 'active',
        provisionState: 'confirmed',
        url: connectionUrl,
        connection: connection ? JSON.parse(JSON.stringify(connection)) : undefined,
      });

      // deployManifest attaches the domain on-chain but doesn't touch barney's
      // registry. Mirror the single-deploy path: cache the attached domain — derived
      // from the SDK RESULT, not the request inputs — so the DNS-polling driver +
      // sidebar dot see it without an app_status round-trip.
      const attachedDomain =
        typeof result.custom_domain === 'string' && result.custom_domain !== '' ? result.custom_domain : '';
      const attachedServiceName = typeof result.service_name === 'string' ? result.service_name : '';
      if (attachedDomain) {
        try {
          const prior = appRegistry.getAppByLease(address, result.lease_uuid)?.customDomains ?? [];
          const others = prior.filter((d) => d.serviceName !== attachedServiceName);
          appRegistry.updateApp(address, result.lease_uuid, {
            customDomains: [...others, { serviceName: attachedServiceName, customDomain: attachedDomain }],
          });
        } catch (error) {
          logError('compositeTransactions.executeConfirmedBatchDeploy.cacheCustomDomain', error);
        }
      }

      updateProgress('ready', 'App is live!');
      return { name, url: connectionUrl };
    },
  });

  return summarizeBatchResult({
    succeeded,
    failed,
    unconfirmed,
    unconfirmedLabel: 'Still deploying',
    cancelled,
    dataKey: 'deployed',
    verb: 'Deployed',
    failedNoun: 'deploys',
    batchProgress,
    onProgress,
  });
}

// ============================================================================
// stop_app
// ============================================================================

/**
 * Pre-validation for stop_app. Returns confirmation result or error.
 * Supports app_name="all" to stop every running/deploying app at once.
 *
 * ENG-312 Phase 4: the confirmed execution (`executeConfirmedStopApp`)
 * delegates to the SDK's `stopApp` primitive, which pre-queries the
 * authoritative on-chain state and dispatches ACTIVE→close-lease /
 * PENDING→cancel-lease / terminal→no-op. Idempotency is now internal to that
 * pre-query (`outcome: 'already_inactive'`) — barney no longer string-matches
 * a `rawLog`. The bulk path fires `stopApp` with `waitForConfirmation: false`
 * so "stop all" doesn't serialize N block confirmations; the single path uses
 * `waitForConfirmation: true`.
 */
export async function executeStopApp(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  // Multi-app stop: "all" or comma-separated names
  const stopFilter = (a: AppEntry) => a.status === 'running' || a.status === 'deploying';
  const multi = resolveMultiAppNames(name, address, appRegistry, stopFilter, 'stop');
  if (multi.mode === 'error') return { success: false, error: multi.error };

  if (multi.mode === 'multi') {
    const names = multi.apps.map((a) => a.name);
    const entries = multi.apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid }));
    const skippedNote = multi.skipped ? ` (skipped: ${multi.skipped.join(', ')})` : '';
    return {
      success: true,
      requiresConfirmation: true,
      confirmationMessage: `Stop ${multi.apps.length} app${multi.apps.length > 1 ? 's' : ''} (${names.join(', ')})? This will terminate all deployments and stop billing.${skippedNote}`,
      pendingAction: {
        toolName: 'stop_app',
        args: { app_name: name, entries },
      },
    };
  }

  // Single app — use normalized name from resolveMultiAppNames
  const singleName = multi.name;
  const app = appRegistry.findApp(address, singleName);
  if (!app) return { success: false, error: `No unique app found matching "${singleName}"` };

  if (app.status === 'stopped') {
    return { success: false, error: `App "${app.name}" is already stopped.` };
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Stop app "${app.name}"? This will terminate the deployment and stop billing.`,
    pendingAction: {
      toolName: 'stop_app',
      args: { app_name: app.name, leaseUuid: app.leaseUuid },
    },
  };
}

/**
 * Execute stop_app after user confirmation.
 * Supports bulk stop when args.entries is present (from app_name="all").
 */
export async function executeConfirmedStopApp(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry, signal } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  // stopApp only needs the tx-path capability slice: the signing
  // CosmosClientManager (broadcast + withBroadcastLock) + a logger. Reuse the
  // ONE store manager so async bulk broadcasts share its sequence cache.
  const ctx: TxCtx = { chain: clientManager, logger: noopLogger };

  // Bulk stop — fire stopApp with waitForConfirmation:false so each TX
  // broadcasts at SYNC/CheckTx level and returns as soon as it hits the
  // mempool (~100ms each) instead of waiting ~6s per TX for block inclusion.
  // Registry is updated optimistically; reconcileWithChain corrects any
  // discrepancies later. ENG-312 Phase 4 behaviour delta: the async path
  // returns hash-only (no DeliverTx result), so a TX that broadcasts but
  // later fails at execution still marks the registry 'stopped' — reconcile
  // fixes it. stopApp's pre-query short-circuits leases already terminal at
  // call time to outcome:'already_inactive' (no doomed broadcast).
  const entries = args.entries as Array<{ app_name: string; leaseUuid: string }> | undefined;
  if (entries && entries.length > 0) {
    const stopped: string[] = [];
    const failed: string[] = [];
    const unconfirmed: string[] = [];
    const cancelled: string[] = [];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      try {
        options.assertAuthorization?.();
        signal?.throwIfAborted();
      } catch (error) {
        logError('compositeTransactions.executeConfirmedStopApp.bulk.guard', error);
        cancelled.push(...entries.slice(index).map((remaining) => remaining.app_name));
        break;
      }

      try {
        await stopApp(
          ctx,
          { leaseUuid: asLeaseUuid(entry.leaseUuid) },
          { waitForConfirmation: false, signal },
        );
        // CHAIN observation only, and optimistic: waitForConfirmation is false,
        // so all we know is the TX reached the mempool; `reconcileWithChain`
        // corrects a DeliverTx rejection later. Nothing is written about
        // provisioning — clearing an undisproven diagnosis is the clobber the
        // observation model exists to prevent.
        appRegistry.updateApp(address, entry.leaseUuid, { chainState: 'absent' });
        stopped.push(entry.app_name);
      } catch (err) {
        logError('compositeTransactions.executeConfirmedStopApp.bulk', err);
        const sent = cancelledTransactionWasSent(err);
        if (isTransactionCancellation(err) && sent !== false) {
          unconfirmed.push(entry.app_name);
          cancelled.push(...entries.slice(index + 1).map((remaining) => remaining.app_name));
          break;
        }
        if (sent === false || isAbortError(err)) {
          cancelled.push(...entries.slice(index).map((remaining) => remaining.app_name));
          break;
        }
        failed.push(entry.app_name);
      }
    }

    if (stopped.length === 0 && unconfirmed.length === 0) {
      const parts: string[] = [];
      if (failed.length > 0) parts.push(`Failed to stop: ${failed.join(', ')}.`);
      if (cancelled.length > 0) parts.push(`Not submitted: ${cancelled.join(', ')}.`);
      return { success: false, error: parts.join(' ') || 'No apps were stopped.' };
    }

    const parts: string[] = [];
    if (stopped.length > 0) parts.push(`Stopped: ${stopped.join(', ')}.`);
    if (unconfirmed.length > 0) {
      parts.push(`Submission uncertain: ${unconfirmed.join(', ')}; check on-chain status before retrying.`);
    }
    if (failed.length > 0) parts.push(`Failed to stop: ${failed.join(', ')}.`);
    if (cancelled.length > 0) parts.push(`Not submitted: ${cancelled.join(', ')}.`);

    return {
      success: true,
      data: {
        message: parts.join(' '),
        stopped,
        failed,
        unconfirmed,
        cancelled,
        status: unconfirmed.length > 0 ? 'unconfirmed' : 'stopped',
      },
    };
  }

  // Single stop — block on confirmation so the chat reply reflects the
  // authoritative outcome. All non-throwing outcomes (stopped / cancelled /
  // already_inactive) map the registry to 'stopped'; a throw is a real
  // failure.
  const name = args.app_name as string;
  const leaseUuid = args.leaseUuid as string;

  options.assertAuthorization?.();
  try {
    const result: StopAppResult = await stopApp(
      ctx,
      { leaseUuid: asLeaseUuid(leaseUuid) },
      { waitForConfirmation: true, signal: options.signal },
    );
    // CHAIN observation only — authoritative here, since waitForConfirmation
    // blocks for the DeliverTx outcome. No provisioning observation touched.
    appRegistry.updateApp(address, leaseUuid, { chainState: 'absent' });
    const message = result.outcome === 'already_inactive'
      ? `App "${name}" has been stopped (lease was already inactive).`
      : `App "${name}" has been stopped.`;
    return {
      success: true,
      data: {
        message,
        app_name: name,
        status: 'stopped',
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to stop app' };
  }
}

// ============================================================================
// fund_credits
// ============================================================================

/**
 * Pre-validation for fund_credits. Returns confirmation result or error.
 *
 * The fund_credits TOOL deliberately stays on
 * `cosmosTx(clientManager, 'billing', 'fund-credit', [address, denomString], true)`
 * and is NOT routed through the SDK's `fundCredits` primitive (which account
 * setup DOES use — see `useAccountSetup`). Pure YAGNI: it's a working one-line
 * chain TX with no provider/upload/poll orchestration to delete, so the
 * migration goal ("delete the hand-rolled deploy spine") doesn't apply here;
 * routing it through `fundCredits` would add indirection for zero behavior change.
 */
export function executeFundCredits(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): ToolResult {
  const { address } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };

  const amount = args.amount;
  if (typeof amount !== 'number' || amount <= 0 || !Number.isFinite(amount)) {
    return { success: false, error: 'Amount must be a positive number.' };
  }

  const microAmount = Math.floor(amount * 1_000_000);
  const denomString = `${microAmount}${DENOMS.PWR}`;

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Add ${amount} credits to your account?`,
    pendingAction: {
      toolName: 'fund_credits',
      args: { amount, microAmount, denomString, address },
    },
  };
}

/**
 * Execute fund_credits after user confirmation.
 */
export async function executeConfirmedFundCredits(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions,
): Promise<ToolResult> {
  const address = args.address as string;
  const denomString = args.denomString as string;
  const amount = args.amount as number;

  if (!address || address !== options.address) {
    return { success: false, error: 'Transaction cancelled: credit target does not match the authorized wallet.' };
  }

  options.assertAuthorization?.();
  const result = await cosmosTx(clientManager, 'billing', 'fund-credit', [address, denomString], true);

  if (result.code !== 0) {
    return { success: false, error: result.rawLog ?? 'Failed to fund credits' };
  }

  return {
    success: true,
    data: {
      message: `Added ${amount} credits to your account.`,
      amount,
      transactionHash: result.transactionHash,
    },
  };
}

// ============================================================================
// cosmos_tx (escape hatch)
// ============================================================================

/** Allowed module+subcommand pairs for the cosmos_tx escape hatch. */
const ALLOWED_TX_COMMANDS: Record<string, Set<string>> = {
  billing: new Set(['create-lease', 'close-lease', 'fund-credit', 'withdraw-credit']),
  bank: new Set(['send']),
  staking: new Set(['delegate', 'redelegate', 'unbond']),
  gov: new Set(['vote', 'submit-proposal']),
};

/**
 * Pre-validation for cosmos_tx. Returns confirmation result or error.
 * Restricted to an allowlist of safe module+subcommand pairs.
 */
export function executeCosmosTransaction(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): ToolResult {
  const { address } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };

  const module = args.module as string;
  const subcommand = args.subcommand as string;
  if (!module) return { success: false, error: 'module is required' };
  if (!subcommand) return { success: false, error: 'subcommand is required' };

  const allowedSubs = ALLOWED_TX_COMMANDS[module];
  if (!allowedSubs || !allowedSubs.has(subcommand)) {
    const allowed = Object.entries(ALLOWED_TX_COMMANDS)
      .map(([m, subs]) => `${m}: ${[...subs].join(', ')}`)
      .join('; ');
    return { success: false, error: `"${module} ${subcommand}" is not allowed. Allowed transactions: ${allowed}` };
  }

  const parseResult = parseJsonStringArray(args.args);
  if (parseResult.error) {
    return { success: false, error: parseResult.error };
  }

  // Safe: parseResult.error was checked above, so data is always defined here
  const parsedArgs = parseResult.data!;
  const argsSummary = parsedArgs.length > 0 ? ` with args: ${parsedArgs.join(', ')}` : '';
  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Execute ${module} ${subcommand}${argsSummary}?`,
    pendingAction: {
      toolName: 'cosmos_tx',
      args: { module, subcommand, parsedArgs, address },
    },
  };
}

/**
 * Execute cosmos_tx after user confirmation.
 */
export async function executeConfirmedCosmosTx(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions,
): Promise<ToolResult> {
  const module = args.module as string;
  const subcommand = args.subcommand as string;
  const parsedArgs = (args.parsedArgs as string[]) ?? [];

  if (typeof args.address === 'string' && args.address !== options.address) {
    return { success: false, error: 'Transaction cancelled: action address does not match the authorized wallet.' };
  }

  options.assertAuthorization?.();
  const result = await cosmosTx(clientManager, module, subcommand, parsedArgs, true);

  if (result.code !== 0) {
    return { success: false, error: result.rawLog ?? 'Transaction failed' };
  }

  return {
    success: true,
    data: {
      message: `Executed ${module} ${subcommand}.`,
      transactionHash: result.transactionHash,
    },
  };
}

// ============================================================================
// restart_app
// ============================================================================

/**
 * Pre-validation for restart_app. Returns confirmation result or error.
 */
export async function executeRestartApp(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  // Multi-app restart: "all" or comma-separated names
  const restartFilter = (a: AppEntry) => a.status === 'running' && !!a.providerUrl;
  const multi = resolveMultiAppNames(name, address, appRegistry, restartFilter, 'restart');
  if (multi.mode === 'error') return { success: false, error: multi.error };

  if (multi.mode === 'multi') {
    const names = multi.apps.map((a) => a.name);
    const entries = multi.apps.map((a) => ({
      app_name: a.name,
      leaseUuid: a.leaseUuid,
      providerUrl: a.providerUrl!,
    }));
    const skippedNote = multi.skipped ? ` (skipped: ${multi.skipped.join(', ')})` : '';
    return {
      success: true,
      requiresConfirmation: true,
      confirmationMessage: `Restart ${multi.apps.length} app${multi.apps.length > 1 ? 's' : ''} (${names.join(', ')})? All apps will be briefly unavailable during restart.${skippedNote}`,
      pendingAction: {
        toolName: 'restart_app',
        args: { app_name: name, entries },
      },
    };
  }

  // Single app — use normalized name from resolveMultiAppNames
  const singleName = multi.name;
  const app = appRegistry.findApp(address, singleName);
  if (!app) return { success: false, error: `No unique app found matching "${singleName}"` };

  // The `app_status` pointer is load-bearing: a timed-out readiness wait records
  // `provisionState: 'unconfirmed'` → derives 'deploying', and `app_status` is
  // the re-observation point that clears it once fred reports `ready`.
  if (app.status !== 'running') {
    return { success: false, error: `App "${app.name}" is not running (status: ${app.status}). Only running apps can be restarted. Run app_status("${app.name}") to refresh its status first.` };
  }

  if (!app.providerUrl) {
    return { success: false, error: `App "${app.name}" has no provider URL.` };
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Restart app "${app.name}"? The app will be briefly unavailable during restart.`,
    pendingAction: {
      toolName: 'restart_app',
      args: {
        app_name: app.name,
        leaseUuid: app.leaseUuid,
        providerUrl: app.providerUrl,
      },
    },
  };
}

/**
 * Execute restart_app after user confirmation.
 * Supports batch restart when args.entries is present (from app_name="all" or comma-separated).
 *
 * restart_app and update_app issue the action through the SDK's own lifecycle
 * primitives (`restartApp` / `updateApp` from `@manifest-network/manifest-sdk/deploy`,
 * ENG-774), then (ENG-312 Phase 6) wait for readiness via the SDK's
 * `waitForLeaseStatus` with a browser `EventTransport` (WS live-status, poll
 * fallback). Do not "finish migrating" them to `deployManifest` — that
 * primitive is create-lease + deploy, not update/restart.
 *
 * Both call options are MANDATORY:
 *   - `pollOptions: false` — return straight after the provider POST, leaving
 *     barney's readiness wait, progress reporting and (update) rollback gate in
 *     charge. What barney takes from the primitives is the `throwIfAborted`
 *     guard before the non-idempotent POST, plus (update only) the ENG-619 5xx
 *     `UPDATE_INDETERMINATE` classification.
 *   - `providerUrl` — selects the fast path; omitting it silently adds two
 *     chain reads per call.
 *
 * ⚠️ The readiness wait mints its own per-poll ADR-036 status token through
 * `ctx.providerAuth` (the same non-reentrant signing mutex), so it must NEVER
 * be wrapped in a caller-side signing mutex / sign-lock — that would deadlock.
 */
export async function executeConfirmedRestartApp(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry, signing, onProgress, signal } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };
  if (!signing) return { success: false, error: 'Wallet does not support message signing' };

  // Batch restart
  const entries = args.entries as Array<{ app_name: string; leaseUuid: string; providerUrl: string }> | undefined;
  if (entries && entries.length > 0) {
    return executeConfirmedBatchRestart(
      entries,
      address,
      appRegistry,
      signing,
      onProgress,
      signal,
      clientManager,
      options.assertAuthorization,
    );
  }

  // ENG-312 Phase 6: the readiness wait now runs through the SDK's
  // waitForLeaseStatus with a browser EventTransport (WS live-status, poll
  // fallback). It mints its own per-poll ADR-036 status token via
  // ctx.providerAuth — NEVER wrap it in a caller-side sign-lock (reentrant mutex
  // deadlock).
  const ctx = await buildBarneyCtx(clientManager, signing, { events: browserEventTransport });

  // Single restart
  const name = args.app_name as string;
  const leaseUuid = args.leaseUuid as string;
  const providerUrl = args.providerUrl as string;

  onProgress?.({ phase: 'restarting', detail: 'Restarting app...', operation: 'restart' });

  options.assertAuthorization?.();
  try {
    // The primitive mints its OWN ADR-036 token through ctx.providerAuth, so
    // never wrap it in a caller-side sign-lock (reentrant mutex deadlock).
    await restartApp(ctx, { address, leaseUuid }, { pollOptions: false, providerUrl, signal });
  } catch (error) {
    logError('compositeTransactions.executeConfirmedRestartApp', error);
    // 409 = lease is not in the right state for restart; don't mark as failed
    // because the app may still be running — only the restart was rejected.
    if (ProviderApiError.isProviderApiError(error) && error.status === 409) {
      onProgress?.({ phase: 'failed', detail: 'App is not in a restartable state', operation: 'restart' });
      return { success: false, error: `Cannot restart "${name}": app is not in a restartable state.` };
    }
    // `restartApp` calls `signal?.throwIfAborted()` after the token mint and
    // before the non-idempotent POST, so an abort here means the provider was
    // never asked and the app is untouched — marking it 'failed' would drop a
    // healthy app out of list_apps(). Any new chat message aborts the shared
    // controller, so this is the ordinary path, not an edge case.
    if (isAbortError(error)) {
      onProgress?.({ phase: 'failed', detail: 'Restart cancelled', operation: 'restart' });
      // No observation written — the entry keeps what it last legitimately had.
      return {
        success: false,
        error: `Restart of "${name}" was cancelled before the provider was asked; the app is unchanged.`,
      };
    }
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    onProgress?.({ phase: 'failed', detail: `Restart failed: ${errorMsg}`, operation: 'restart' });
    // No observation, like the abort arm: a throw here is about INITIATING the
    // restart, never about the workload — token mint before the POST, transport
    // error, 4xx refusal, or a fred 500, which returns from `routeReplaceRestart`'s
    // prelude before the actor handoff (fred internal/backend/docker/restart_update.go).
    // No container was touched, and 'failed' would drop a healthy app out of
    // list_apps(running), restart_app and DNS polling.
    return { success: false, error: `Restart failed: ${errorMsg}` };
  }

  // Poll for readiness
  onProgress?.({ phase: 'provisioning', detail: 'Waiting for app to come back up...', operation: 'restart' });

  try {
    const fredStatus = await waitForLeaseStatus(ctx, asLeaseUuid(leaseUuid), {
      timeout: AI_LEASE_WAIT_TIMEOUT_MS,
      intervalMs: FRED_POLL_INTERVAL_MS,
      signal,
      onStatus: (status) => {
        onProgress?.({
          phase: 'provisioning',
          detail: status.phase || 'Waiting for restart...',
          fredStatus: status,
          operation: 'restart',
        });
      },
    });

    // Deliberately NO post-wait /provision gate here — do NOT mirror the update
    // one onto restart. When a restart fails and the rollback restores the old
    // containers, fred CLEARS reason/message/last_error and reports a clean
    // 'ready' (`onEnterReadyFromReplaceRecovered`, guarded on
    // `OldStopped && Operation == "restart"`, fred
    // internal/backend/shared/leasesm/lease_sm.go); only fail_count moves. The
    // gate would never fire. The update gate works because an update KEEPS them.
    if (!isLeaseFailureTerminal(fredStatus)) {
      const { url: connectionUrl, connection } = await resolveAppUrl(
        providerUrl, leaseUuid, fredStatus, address, signing,
        'compositeTransactions.executeConfirmedRestartApp'
      );

      // Provider observation: the wait resolved non-terminal — the workload is up.
      appRegistry.updateApp(address, leaseUuid, {
        provisionState: 'confirmed',
        url: connectionUrl,
        connection: connection ? JSON.parse(JSON.stringify(connection)) : undefined,
      });
      onProgress?.({ phase: 'ready', operation: 'restart' });

      return {
        success: true,
        data: {
          message: `App "${name}" has been restarted.`,
          name,
          url: connectionUrl,
          status: 'running',
        },
      };
    }

    // Non-active terminal state or failed provision — the provider gave a verdict.
    appRegistry.updateApp(address, leaseUuid, { provisionState: 'failed' });
    onProgress?.({ phase: 'failed', detail: failureText(fredStatus, 'Restart failed'), operation: 'restart' });
    return { success: false, error: `Restart failed: ${failureText(fredStatus, 'App did not come back up')}` };
  } catch (error) {
    logError('compositeTransactions.executeConfirmedRestartApp.polling', error);
    // waitForLeaseStatus REJECTS on timeout/setup/transport error and on abort.
    // Record on a genuine wait failure so registry surfaces don't keep showing a
    // possibly-broken app as 'running'; on a USER abort record nothing — the
    // restart likely still proceeds provider-side. The copy tracks the same
    // observation, so no surface asserts a failure fred never issued.
    const observation = provisionObservationFromWaitError(error);
    if (!isAbortError(error)) {
      appRegistry.updateApp(address, leaseUuid, { provisionState: observation });
    }
    if (observation === 'failed') {
      const detail = error instanceof Error ? error.message : 'App did not come back up';
      onProgress?.({ phase: 'failed', detail, operation: 'restart' });
      return { success: false, error: `Restart failed: ${detail}` };
    }
    onProgress?.({ phase: 'failed', detail: 'Restart not confirmed', operation: 'restart' });
    return { success: false, error: `Restart may still be in progress. Use app_status("${name}") to check.` };
  }
}

/**
 * Batch restart: restart multiple apps concurrently with bounded concurrency.
 * Uses a signing mutex to serialize signArbitrary calls (shared wallet sequence numbers).
 */
async function executeConfirmedBatchRestart(
  entries: Array<{ app_name: string; leaseUuid: string; providerUrl: string }>,
  address: string,
  appRegistry: ToolExecutorOptions['appRegistry'] & object,
  signing: SigningContext,
  onProgress: ToolExecutorOptions['onProgress'],
  signal: AbortSignal | undefined,
  clientManager: CosmosClientManager,
  assertAuthorization: ToolExecutorOptions['assertAuthorization'],
): Promise<ToolResult> {
  const batchEntries = entries.map((e) => ({ ...e, name: e.app_name }));

  // One shared ctx for all concurrent waits (WS live-status via the browser
  // EventTransport; poll fallback). Never wrapped in a caller-side sign-lock.
  const ctx = await buildBarneyCtx(clientManager, signing, { events: browserEventTransport });

  const { succeeded, failed, unconfirmed, cancelled, batchProgress } = await runBatchWithConcurrency({
    entries: batchEntries,
    intermediatePhases: ['provisioning', 'restarting'],
    initialPhase: 'restarting',
    operation: 'restart',
    signal,
    onProgress,
    executeOne: async (entry, _i, updateProgress) => {
      const name = entry.app_name;

      updateProgress('restarting', 'Restarting...');

      // Called DIRECTLY under runBatchWithConcurrency: the primitive mints its
      // own ADR-036 token through the non-reentrant signing mutex, exactly as
      // batch deploy calls deployManifest directly.
      try {
        assertAuthorization?.();
        signal?.throwIfAborted();
      } catch (error) {
        logError('executeConfirmedBatchRestart.guard', error);
        updateProgress('failed', 'Cancelled before the provider was asked');
        return { name, outcome: 'cancelled' as const };
      }
      try {
        await restartApp(
          ctx,
          { address, leaseUuid: entry.leaseUuid },
          { pollOptions: false, providerUrl: entry.providerUrl, signal }
        );
      } catch (error) {
        logError('executeConfirmedBatchRestart.restart', error);
        if (ProviderApiError.isProviderApiError(error) && error.status === 409) {
          updateProgress('failed', 'Not in a restartable state');
          return null;
        }
        // Same abort guard as the single path, and it bites hardest here: a
        // "restart all" queues most entries behind the signing mutex, so one new
        // chat message aborts several at once. Never restarted, still healthy.
        if (isAbortError(error)) {
          updateProgress('failed', 'Cancelled before the provider was asked');
          return { name, outcome: 'cancelled' as const };
        }
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        updateProgress('failed', `Restart failed: ${errorMsg}`);
        // No observation, exactly as on the single-restart POST site — the
        // restart was never initiated, so nothing saw the workload fail. The
        // entry still reports under `Failed:`: the OPERATION failed.
        return null;
      }

      // Poll for readiness
      updateProgress('provisioning', 'Waiting for app to come back up...');

      try {
        const fredStatus = await waitForLeaseStatus(ctx, asLeaseUuid(entry.leaseUuid), {
          timeout: AI_LEASE_WAIT_TIMEOUT_MS,
          intervalMs: FRED_POLL_INTERVAL_MS,
          signal,
          onStatus: (status) => {
            updateProgress('provisioning', status.phase || 'Restarting...');
          },
        });

        if (!isLeaseFailureTerminal(fredStatus)) {
          const { url: connectionUrl, connection } = await resolveAppUrl(
            entry.providerUrl, entry.leaseUuid, fredStatus, address, signing,
            'executeConfirmedBatchRestart'
          );

          appRegistry.updateApp(address, entry.leaseUuid, {
            provisionState: 'confirmed',
            url: connectionUrl,
            connection: connection ? JSON.parse(JSON.stringify(connection)) : undefined,
          });
          updateProgress('ready', 'App is live!');
          return { name, url: connectionUrl };
        }

        appRegistry.updateApp(address, entry.leaseUuid, { provisionState: 'failed' });
        updateProgress('failed', failureText(fredStatus, 'Restart failed'));
        return null;
      } catch (error) {
        logError('executeConfirmedBatchRestart.poll', error);
        // An abort at the WAIT site is the same event as one at the POST site,
        // so it takes the same `cancelled` outcome rather than bucketing every
        // in-flight entry of a "restart all" under `Failed:`.
        if (isAbortError(error)) {
          updateProgress('failed', 'Cancelled while waiting for the app to come back up');
          return { name, outcome: 'cancelled' as const };
        }
        // Same silence-is-not-a-verdict rule as the single-restart wait catch,
        // and it bites harder here: N waits share one budget. The BUCKET has to
        // follow the observation too — bucketing silence under `Failed:` printed
        // "All restarts failed" for a batch fred never ruled on.
        const observation = provisionObservationFromWaitError(error);
        appRegistry.updateApp(address, entry.leaseUuid, { provisionState: observation });
        if (observation === 'unconfirmed') {
          updateProgress('failed', `Restart not confirmed for "${name}". Use app_status("${name}") to check.`);
          return { name, outcome: 'unconfirmed' as const, detail: `no verdict from the provider — check app_status("${name}")` };
        }
        updateProgress('failed', `Restart failed for "${name}": ${error instanceof Error ? error.message : 'Unknown error'}`);
        return null;
      }
    },
  });

  return summarizeBatchResult({
    succeeded,
    failed,
    unconfirmed,
    unconfirmedLabel: 'Still restarting',
    cancelled,
    dataKey: 'restarted',
    verb: 'Restarted',
    failedNoun: 'restarts',
    batchProgress,
    operation: 'restart',
    onProgress,
  });
}

// ============================================================================
// update_app
// ============================================================================

/**
 * Pre-validation for update_app. Returns confirmation result or error.
 */
export async function executeUpdateApp(
  args: Record<string, unknown>,
  options: ToolExecutorOptions,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  // Stack-based update: build stack manifest from services param
  if (!payload && typeof args.services === 'string' && args.services) {
    if (args.image) {
      return { success: false, error: '"image" and "services" are mutually exclusive.' };
    }

    const parsed = parseAndValidateStackServices(
      args.services as string, false, 'compositeTransactions.executeUpdateApp.parseServices'
    );
    if ('error' in parsed) return { success: false, error: parsed.error };

    // Pre-generate a shared password for all auto-generated env vars in the stack.
    const sharedPassword = generatePassword();
    for (const svc of Object.values(parsed.services)) {
      if (svc.env) {
        for (const key of Object.keys(svc.env)) {
          svc.env[key] = resolveGeneratedPassword(svc.env[key], () => sharedPassword);
        }
      }
    }

    let manifestResult;
    try {
      manifestResult = await buildStackManifest({ services: parsed.services });
    } catch (error) {
      logError('compositeTransactions.executeUpdateApp.buildStackManifest', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to build stack manifest' };
    }

    payload = manifestResult.payload;
    args._generatedManifest = manifestResult.json;
    args._isStack = true;
    args._serviceNames = parsed.serviceNames;
  }

  // Image-based update: build manifest from args when no file is attached.
  // Env + health_check KNOWN_IMAGES defaults are skipped (applyEnvDefaults/
  // applyHealthCheckDefault=false) — the old-manifest merge carries those
  // forward — and app-name is not derived (the app already exists).
  if (!payload && args.image) {
    const built = await buildImageManifestFromArgs(args, {
      applyEnvDefaults: false,
      applyHealthCheckDefault: false,
      deriveAppName: false,
      errorContext: 'executeUpdateApp',
    });
    if ('error' in built) return { success: false, error: built.error };
    payload = built.payload;
  }

  if (!payload) {
    return { success: false, error: 'No file attached and no image specified. Attach a manifest file or specify a Docker image (e.g. update_app(app_name="my-app", image="redis:8")).' };
  }

  // Make file-attached JSON manifests editable in the confirmation card, and run
  // the blocked-env-name guard on the uploaded env at parse time (before merge).
  // NOT gated on the .json extension: .txt uploads must contain JSON too (see
  // fileValidation), and the merge/deploy path below JSON.parses payload.bytes
  // regardless of extension — so gating the guard on .json would let a
  // manifest.txt bypass the env-name blocklist (S3). Mirrors executeDeployApp.
  if (!args._generatedManifest) {
    try {
      const json = new TextDecoder().decode(payload.bytes);
      const parsedManifest: unknown = JSON.parse(json); // validate it's valid JSON
      const envError = validateManifestEnvNames(parsedManifest);
      if (envError) return { success: false, error: envError };
      args._generatedManifest = json;
    } catch {
      // Not valid JSON — fall through to read-only display
    }
  }

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  const app = appRegistry.findApp(address, name);
  if (!app) return { success: false, error: `No unique app found matching "${name}"` };

  // 'deploying' is deliberately NOT in the allowed set — pushing a new manifest
  // at a lease that may still be provisioning races the provisioner.
  if (app.status !== 'running' && app.status !== 'failed') {
    return { success: false, error: `App "${app.name}" cannot be updated (status: ${app.status}). Only running or failed apps can be updated. Run app_status("${app.name}") to refresh its status first.` };
  }

  if (!app.providerUrl) {
    return { success: false, error: `App "${app.name}" has no provider URL.` };
  }

  // Merge old manifest values (env, ports, user, tmpfs) as defaults
  // Stack updates use full manifest replacement — no partial merge
  if (app.manifest && !args._isStack) {
    try {
      const currentJson = typeof args._generatedManifest === 'string'
        ? args._generatedManifest
        : new TextDecoder().decode(payload.bytes);

      const currentManifest = JSON.parse(currentJson);
      const merged = mergeManifest(currentManifest, app.manifest);
      const mergedJson = JSON.stringify(merged, null, 2);

      if (mergedJson !== currentJson) {
        const bytes = new TextEncoder().encode(mergedJson);
        const hash = toHex(await sha256(mergedJson));
        payload = { bytes, filename: payload.filename, size: bytes.length, hash };
        args._generatedManifest = mergedJson;
      }
    } catch (error) {
      // Merge is best-effort — proceed with original manifest if it fails
      // (e.g., YAML payloads or invalid old manifest)
      logError('compositeTransactions.executeUpdateApp.mergeManifest', error);
    }
  }

  let stackServiceCount = 0;
  if (args._isStack) {
    const serviceNamesResult = validateInternalServiceNames(args._serviceNames, 'update_app');
    if (serviceNamesResult.error || !serviceNamesResult.serviceNames || serviceNamesResult.serviceNames.length === 0) {
      return {
        success: false,
        error: serviceNamesResult.error ?? 'Invalid stack service metadata. Please run update_app again with a valid services definition.',
      };
    }
    stackServiceCount = serviceNamesResult.serviceNames.length;
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: args._isStack
      ? `Update stack "${app.name}" with ${stackServiceCount} services (new manifest)?`
      : `Update app "${app.name}" with ${args._generatedManifest ? `image ${args.image}` : 'new manifest'}?`,
    pendingAction: {
      toolName: 'update_app',
      args: {
        app_name: app.name,
        leaseUuid: app.leaseUuid,
        providerUrl: app.providerUrl,
        ...(args._generatedManifest ? { _generatedManifest: args._generatedManifest } : {}),
        ...(args._isStack ? { _isStack: true } : {}),
      },
    },
  };
}

/**
 * Fred failure reasons a freshly-attempted update can legitimately be blamed
 * for. Used ONLY as a negative filter in the rollback gate: a reason we
 * recognize that is NOT in here means the update applied and the app failed
 * afterwards for an unrelated cause (`ContainerExited` lands on the very same
 * provision record).
 *
 * The direction is load-bearing: a reason from a newer fred is in neither this
 * set nor `isKnownFailureReason`, so it falls THROUGH to the conservative
 * rollback branch. `ImagePullFailed` must stay in — `doUpdate`'s preflight
 * authors it, so a gate written as `reason === 'UpdateFailed'` would misread a
 * preflight failure as a post-update crash.
 */
const UPDATE_ATTRIBUTABLE_REASONS: ReadonlySet<string> = new Set([
  'UpdateFailed',
  'ImagePullFailed',
  'Internal',
  'Unknown',
]);

/**
 * True when a throw from `POST /update` leaves the outcome genuinely unknown
 * (ENG-619).
 *
 * The SDK's `updateApp` maps `ProviderApiError` with `status >= 500` to
 * `UPDATE_INDETERMINATE`; the raw `status >= 500` arm catches a 5xx that arrives
 * unwrapped (DEV /proxy-provider and PROD nginx both mint their own 502).
 * Deliberately NOT extended to status 0 — also in doubt, different story.
 */
function isIndeterminateUpdateError(error: unknown): boolean {
  if (error instanceof ManifestMCPError && error.code === ManifestMCPErrorCode.UPDATE_INDETERMINATE) return true;
  return ProviderApiError.isProviderApiError(error) && error.status >= 500;
}

/**
 * Execute update_app after user confirmation.
 */
export async function executeConfirmedUpdateApp(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  const { address, appRegistry, signing, onProgress, signal } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };
  if (!signing) return { success: false, error: 'Wallet does not support message signing' };

  // Reconstruct payload from stored manifest JSON (image-based update)
  if (!payload && typeof args._generatedManifest === 'string') {
    payload = await buildPayloadFromManifest(args._generatedManifest);
  }

  if (!payload) return { success: false, error: 'Payload missing' };

  const name = args.app_name as string;
  const leaseUuid = args.leaseUuid as string;
  const providerUrl = args.providerUrl as string;

  onProgress?.({ phase: 'updating', detail: 'Updating app with new manifest...', operation: 'update' });

  // Still needed for the post-wait /provision read below; the update POST and
  // the readiness wait mint their own through ctx.providerAuth.
  const refreshAuthToken = () => signing.authTokens.getAuthToken(asLeaseUuid(leaseUuid));

  const ctx = await buildBarneyCtx(clientManager, signing, { events: browserEventTransport });

  // `payload.bytes` is already the FINAL upload body — executeUpdateApp merged
  // the stored manifest in at plan time. `existingManifest` is therefore
  // deliberately NOT passed on: a second merge would re-inject deleted fields.
  const manifestJson = new TextDecoder().decode(payload.bytes);

  options.assertAuthorization?.();
  try {
    // `pollOptions: false` + `providerUrl` are both mandatory — see the JSDoc
    // on executeRestartApp. Never wrapped in a caller-side sign-lock.
    await updateApp(
      ctx,
      { address, leaseUuid, manifest: manifestJson },
      { pollOptions: false, providerUrl, signal }
    );
  } catch (error) {
    logError('compositeTransactions.executeConfirmedUpdateApp', error);
    // 409 = lease is not in the right state for update; don't mark as failed
    // because the app may still be running — only the update was rejected.
    // (The primitive rethrows 4xx untouched; only >= 500 is reclassified.)
    if (ProviderApiError.isProviderApiError(error) && error.status === 409) {
      onProgress?.({ phase: 'failed', detail: 'App is not in an updatable state', operation: 'update' });
      return { success: false, error: `Cannot update "${name}": app is not in an updatable state.` };
    }
    // ENG-619: a 5xx from POST /update does NOT establish that the update was
    // rejected. Fred answers 500 both when it refuses before the backend AND
    // when the backend applied it but persisting the payload failed — identical
    // bodies. A flat failure here pushes a model toward close-and-redeploy.
    if (isIndeterminateUpdateError(error)) {
      // NO registry write, deliberately: writing `provisionState` would invent a
      // verdict out of an ambiguous 500. The entry keeps its last real
      // observation and the PREVIOUS manifest — the durable truth either way,
      // since fred reverts an unrecorded update on its next reprovision.
      //
      // The copy says "version", not "manifest": MessageBubble's ERROR_PATTERNS
      // matches /manifest/ and would attach a "Deploy an app" button — the one
      // action this branch exists to talk the user out of.
      onProgress?.({ phase: 'failed', detail: 'Update outcome unknown', operation: 'update' });
      return {
        success: false,
        error:
          `The provider could not durably record the update to "${name}", so it may or may not have been applied ` +
          `— and an update that WAS applied but not recorded is reverted by the provider's next reprovision. ` +
          `Check app_status("${name}") and app_releases("${name}") to see which version is actually live; the copy ` +
          `stored here is still the previous one. Re-running update_app("${name}") is safe and re-applies AND ` +
          `re-records it. Do NOT stop the app and redeploy — it may be running.`,
      };
    }
    // Twin of the restart POST-site guard. ORDER matters as much as the gate:
    // `isIndeterminateUpdateError` above runs first, so a 5xx that coincides
    // with an abort still gets the ENG-619 story, not "the app is unchanged".
    if (isAbortError(error)) {
      onProgress?.({ phase: 'failed', detail: 'Update cancelled', operation: 'update' });
      // No observation: the provider was never asked.
      return {
        success: false,
        error: `Update of "${name}" was cancelled before the provider was asked; the app is unchanged.`,
      };
    }
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    onProgress?.({ phase: 'failed', detail: `Update failed: ${errorMsg}`, operation: 'update' });
    // No observation, and stronger than the restart twin: 5xx left via the
    // indeterminate arm above, so what remains is a 4xx refusal, a transport
    // error, or INVALID_CONFIG — which `updateApp` raises while MERGING the
    // manifest, before any POST. The replacement never started; the previous
    // version is still live, and its manifest is still the stored one.
    return { success: false, error: `Update failed: ${errorMsg}` };
  }

  // Snapshot existing app state before overwriting — needed for rollback detection.
  const existingApp = appRegistry.getAppByLease(address, leaseUuid);
  const previousUrl = existingApp?.url;
  const previousManifest = existingApp?.manifest;

  // Update registry with new manifest content (secrets stripped)
  appRegistry.updateApp(address, leaseUuid, { manifest: sanitizeManifestForStorage(manifestJson) });

  // Poll for readiness. ENG-312 Phase 6: SDK waitForLeaseStatus with a browser
  // EventTransport (WS live-status, poll fallback). It mints its own per-poll
  // ADR-036 status token via ctx.providerAuth — never wrap in a caller-side sign-lock.
  onProgress?.({ phase: 'provisioning', detail: 'Waiting for app to come back up...', operation: 'update' });

  try {
    const fredStatus = await waitForLeaseStatus(ctx, asLeaseUuid(leaseUuid), {
      timeout: AI_LEASE_WAIT_TIMEOUT_MS,
      intervalMs: FRED_POLL_INTERVAL_MS,
      signal,
      onStatus: (status) => {
        onProgress?.({
          phase: 'provisioning',
          detail: status.phase || 'Waiting for update...',
          fredStatus: status,
          operation: 'update',
        });
      },
    });

    if (!isLeaseFailureTerminal(fredStatus)) {
      // Rollback detection: a non-failure terminal wait is NOT proof the update
      // took. Fred settles the rollback before emitting the terminal WS event,
      // so /provision is authoritative here once SETTLED. Wire shapes, off fred
      // v0.13.0 (`internal/backend/shared/leasesm/lease_sm.go` entry actions +
      // `internal/api/handlers.go` LeaseProvisionResponse):
      //   - Update OK:       {status:'ready',  fail_count:N}                    reason+message CLEARED
      //   - Rollback OK:     {status:'ready',  fail_count:N+1, reason:'UpdateFailed',
      //                       message:'update failed; rolled back to previous version'}
      //   - Rollback failed: {status:'failed', reason:'UpdateFailed', message:'update failed; rollback failed'}
      //   - Image-pull preflight: {status:'failed', reason:'ImagePullFailed', message:'image pull failed'}
      // `last_error` is in NONE of them — the field was deleted from the
      // response struct, so a `if (provision.last_error)` gate is permanently
      // false. `describeFredFailure` reads either era.
      try {
        const provisionToken = await refreshAuthToken();
        const provision = await getLeaseProvision(providerUrl, leaseUuid, provisionToken);
        // PRECONDITION: only a SETTLED provision carries a verdict about THIS
        // update. `applyReplaceEntry` (lease_sm.go) writes Status when entering
        // Updating without clearing a retained prior Reason/Message, so a
        // mid-update read answers {status:'updating', reason:'UpdateFailed'} —
        // the PREVIOUS update's verdict. Reachable: on a degraded provider
        // `omitempty` drops provision_status and the SDK's classifyTerminal
        // skips its provision checks when it is undefined, so the wait resolves
        // "success" mid-update. Provider JSON is type-asserted rather than
        // validated, so `isUnsettledProvisionStatus` re-checks absent/empty at
        // runtime. It is the SAME predicate `executeAppStatus`'s no-retract guard
        // uses (provisionStatus.ts), so the two files cannot disagree on `failing`.
        const settled = !isUnsettledProvisionStatus(provision.status);
        if (settled && describeFredFailure(provision)) {
          // A failure signal is a sound update-verdict ONLY here, and only on
          // three fred facts: a successful replace clears reason/message
          // atomically with the Ready flip; fred writes Status=Updating BEFORE
          // acking POST /update, so this cannot be a stale pre-update 'ready';
          // and the `settled` gate rules out the mid-replace window. Do NOT copy
          // this gate onto a surface inspecting an arbitrary lease at an
          // arbitrary time — fred RETAINS reason on a healthy rolled-back lease.
          //
          // Residual false positive: the container dies right after a SUCCESSFUL
          // update, stamping an unrelated reason. Filtered negatively — see
          // UPDATE_ATTRIBUTABLE_REASONS.
          const reason = provision.reason;
          const appliedThenFailed =
            reason !== undefined &&
            isKnownFailureReason(reason) &&
            !UPDATE_ATTRIBUTABLE_REASONS.has(reason);

          if (appliedThenFailed) {
            // Provider verdict: the workload it is running has failed.
            appRegistry.updateApp(address, leaseUuid, { provisionState: 'failed' });
            onProgress?.({ phase: 'failed', detail: 'Update applied, app has since failed.', operation: 'update' });
            return {
              success: false,
              error:
                `The update applied but "${name}" has since failed: ` +
                `${normalizeErrorPunctuation(failureText(provision, 'no detail reported'))}. ` +
                `Use app_status("${name}") to check.`,
            };
          }

          // ImagePullFailed is authored by doUpdate's PREFLIGHT (fred
          // internal/backend/docker/restart_update.go): PullImage fails before
          // doReplaceContainers, so no container was touched and there was no
          // rollback to succeed or fail. Saying "rollback failed" would assert a
          // mechanism that never ran, on the commonest update failure there is.
          const preflight = reason === 'ImagePullFailed';
          const rollbackOk = provision.status === 'ready';
          appRegistry.updateApp(address, leaseUuid, {
            // Relay fred's own `provision.status`: `ready` (rollback landed) is
            // a confirmation, anything else is fred's failure verdict —
            // including a preflight ImagePullFailed, where the old containers
            // are still up but the desired state was never achieved. The
            // registry mirrors fred; the chat COPY is what bends to match.
            provisionState: rollbackOk ? 'confirmed' : 'failed',
            ...(previousManifest ? { manifest: previousManifest } : {}),
          });
          onProgress?.({
            phase: 'failed',
            detail: preflight
              ? 'Update failed: the image could not be pulled — nothing was changed.'
              : rollbackOk
                ? 'Update failed, previous version restored.'
                : 'Update failed and rollback failed.',
            operation: 'update',
          });
          const detail = failureText(provision, 'no detail reported');
          // Curated per-reason guidance through barney's remapper — never the
          // SDK's `guidanceFor` directly: `Unknown`'s SDK sentence says
          // `get_logs({ lease_uuid })`, a call shape barney's
          // `get_logs(app_name)` rejects (see failureGuidance.ts). Appended on
          // EVERY arm because ImagePullFailed's line is the only actionable one
          // for the preflight branch; absent for an unknown reason.
          const nextStep = nextStepFor(reason, name);
          const suffix = nextStep ? ` ${nextStep}` : '';
          return {
            success: false,
            // The preflight copy must not claim what is serving — the registry
            // records fred's `failed` verdict — so it leads with the failure and
            // keeps "nothing was changed" as blast-radius reassurance only.
            error: preflight
              ? `Update failed: the image could not be pulled, so the new version was never applied and ` +
                `nothing was changed on the provider. ${normalizeErrorPunctuation(detail)}.${suffix}`
              : rollbackOk
                ? `Update failed, previous version restored. ${normalizeErrorPunctuation(detail)}.${suffix}`
                : `Update failed and rollback failed. ${normalizeErrorPunctuation(detail)}. ` +
                  `Use app_status("${name}") to check.${suffix}`,
          };
        }
      } catch (error) {
        // Provision check is best-effort — if it fails, proceed with the success path.
        logError('compositeTransactions.executeConfirmedUpdateApp.provisionCheck', error);
      }

      const { url: connectionUrl, connection } = await resolveAppUrl(
        providerUrl, leaseUuid, fredStatus, address, signing,
        'compositeTransactions.executeConfirmedUpdateApp'
      );

      // If resolved URL lost port info, fall back to the previous URL
      const hasPort = connectionUrl != null && /:\d+/.test(connectionUrl.replace(/^https?:\/\//, ''));
      const finalUrl = (hasPort ? connectionUrl : previousUrl) ?? connectionUrl;

      // Provider observation: the wait resolved non-terminal and the settled
      // /provision read above carried no failure signal.
      appRegistry.updateApp(address, leaseUuid, {
        provisionState: 'confirmed',
        url: finalUrl,
        connection: connection ? JSON.parse(JSON.stringify(connection)) : undefined,
      });
      onProgress?.({ phase: 'ready', operation: 'update' });

      return {
        success: true,
        data: {
          message: `App "${name}" has been updated.`,
          name,
          url: finalUrl,
          status: 'running',
        },
      };
    }

    // Non-active terminal state or failed provision — the provider gave a verdict.
    appRegistry.updateApp(address, leaseUuid, { provisionState: 'failed' });
    onProgress?.({ phase: 'failed', detail: failureText(fredStatus, 'Update failed'), operation: 'update' });
    return { success: false, error: `Update failed: ${failureText(fredStatus, 'App did not come back up')}` };
  } catch (error) {
    logError('compositeTransactions.executeConfirmedUpdateApp.polling', error);
    // Same rule as the restart wait catch. Note the asymmetry with the branches
    // ABOVE, which do write `'failed'`: those ran on a resolved status or a
    // settled /provision read — fred actually answered. Only this catch is the
    // no-answer case, and the copy tracks the observation.
    const observation = provisionObservationFromWaitError(error);
    if (!isAbortError(error)) {
      appRegistry.updateApp(address, leaseUuid, { provisionState: observation });
    }
    if (observation === 'failed') {
      const detail = error instanceof Error ? error.message : 'App did not come back up';
      onProgress?.({ phase: 'failed', detail, operation: 'update' });
      return { success: false, error: `Update failed: ${detail}` };
    }
    onProgress?.({ phase: 'failed', detail: 'Update not confirmed', operation: 'update' });
    return { success: false, error: `Update may still be in progress. Use app_status("${name}") to check.` };
  }
}

// ============================================================================
// set_custom_domain
// ============================================================================

/**
 * Pre-validation for set_custom_domain. Returns confirmation result or error.
 *
 * **Single-domain-per-LeaseItem assumption.** The chain currently enforces a
 * single `custom_domain` string per `LeaseItem`, and the empty string is the
 * sentinel for "clear" (see `MsgSetItemCustomDomain` in proto). This function,
 * the `CustomDomainCardData` shape, the AI tool schema, the success-message
 * wording, and the `ConfirmationCard` clear/attach branching all bake that
 * cardinality in. If the chain ever moves to `customDomains: string[]` (SAN
 * certs, multiple aliases per service), the entry points to revisit are:
 *   - this function (`executeSetCustomDomain`) and `executeConfirmedSetCustomDomain`
 *   - `executeDeployApp` and `executeConfirmedDeployApp` (the `customDomain` /
 *     `customDomainServiceName` pre-attach path added in Pass B)
 *   - the `set_custom_domain` and `deploy_app` schemas in `ai/tools.ts`
 *   - the `MessageCard` discriminated union and `CustomDomainCardData`
 *   - the chat success messages in `executeConfirmedSetCustomDomain` and
 *     `executeConfirmedDeployApp`
 *   - the `ConfirmationCard` `CustomDomainBranch` and `deployWithCustomDomain`
 *     sections (clear/attach branching, DNS table)
 */
export async function executeSetCustomDomain(
  args: Record<string, unknown>,
  options: ToolExecutorOptions,
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const appName = String(args.app_name ?? '').trim();
  if (typeof args.custom_domain !== 'string') {
    return { success: false, error: 'custom_domain must be a string (use "" to clear).' };
  }
  const customDomain = normalizeFqdn(args.custom_domain);
  const explicitServiceName = typeof args.service_name === 'string' ? args.service_name.trim() : '';

  if (!appName) return { success: false, error: 'app_name is required.' };

  const app = appRegistry.findApp(address, appName);
  if (!app) return { success: false, error: `No app found matching "${appName}".` };

  // Validate format/apex/reserved when not clearing
  let warning: string | undefined;
  if (customDomain !== '') {
    const validation = await validateAll(customDomain);
    if (validation.error) return { success: false, error: validation.error };
    warning = validation.warning;
  }

  // Resolve service_name from chain LeaseItems
  let leaseItems: Awaited<ReturnType<typeof getLeaseItemsForLease>>;
  try {
    leaseItems = await getLeaseItemsForLease(app.leaseUuid);
  } catch (err) {
    logError('compositeTransactions.executeSetCustomDomain.getLeaseItems', err);
    return { success: false, error: 'Failed to read lease items from chain. Try again.' };
  }

  if (!leaseItems || leaseItems.length === 0) {
    return { success: false, error: `No lease items found for "${appName}". The lease may have been closed.` };
  }

  let serviceName = '';
  const namedItems = leaseItems.filter(i => i.serviceName !== '');
  const unnamedItems = leaseItems.filter(i => i.serviceName === '');

  if (leaseItems.length === 1 && unnamedItems.length === 1) {
    // Legacy single-item lease: serviceName must be "" on chain.
    if (explicitServiceName !== '') {
      return {
        success: false,
        error: `"${appName}" is a single-service app — drop the service_name argument.`,
      };
    }
    serviceName = '';
  } else if (unnamedItems.length > 0 && namedItems.length === 0) {
    // Multi-item legacy lease — chain rejects these for custom_domain.
    return {
      success: false,
      error: `"${appName}" predates per-service domains and has multiple items without service names. Re-deploy with explicit service names to use custom domains.`,
    };
  } else {
    // Modern lease(s) with per-service names. Auto-select when there's only one
    // (no ambiguity); only require service_name for true multi-service stacks.
    if (!explicitServiceName) {
      if (namedItems.length === 1) {
        serviceName = namedItems[0].serviceName;
      } else {
        const available = namedItems.map(i => i.serviceName).join(', ');
        return {
          success: false,
          error: `"${appName}" is a multi-service stack — pass service_name. Available services: ${available}.`,
        };
      }
    } else {
      const match = namedItems.find(i => i.serviceName === explicitServiceName);
      if (!match) {
        const available = namedItems.map(i => i.serviceName).join(', ');
        return {
          success: false,
          error: `Service "${explicitServiceName}" not found in "${appName}". Available: ${available}.`,
        };
      }
      serviceName = explicitServiceName;
    }
  }

  // Find current domain on the matched item (for change-detection)
  const currentDomain = getDomainForService(leaseItems, serviceName);

  if (customDomain === currentDomain) {
    if (customDomain === '') {
      return { success: false, error: `"${appName}" has no custom domain to clear.` };
    }
    return { success: false, error: `"${appName}" already has "${customDomain}" attached.` };
  }

  // Uniqueness pre-check (not authoritative — chain still verifies on TX).
  // Two reject cases:
  //  1. The domain is on a *different* lease entirely.
  //  2. The domain is on this same lease but a *different* service. The chain
  //     also rejects this; we surface a friendlier message that names the
  //     service currently holding it.
  if (customDomain !== '') {
    try {
      const existing = await queryLeaseByCustomDomain(customDomain);
      if (existing) {
        if (existing.leaseUuid !== app.leaseUuid) {
          return {
            success: false,
            error: `"${customDomain}" is already attached to another lease. Pick a different domain.`,
          };
        }
        if (existing.serviceName !== serviceName) {
          const heldBy = existing.serviceName === ''
            ? 'this app'
            : `service "${existing.serviceName}" on this app`;
          return {
            success: false,
            error: `"${customDomain}" is already attached to ${heldBy}. Clear it from there first, or pick a different domain.`,
          };
        }
      }
    } catch (err) {
      logError('compositeTransactions.executeSetCustomDomain.queryLeaseByCustomDomain', err);
      // Don't block — chain will reject if duplicate.
    }
  }

  const expectedCnameTarget = resolveExpectedCnameTarget(app.connection, serviceName);

  let confirmationMessage: string;
  if (customDomain === '') {
    confirmationMessage = `Clear custom domain "${currentDomain}" from "${appName}"?`;
  } else if (currentDomain === '') {
    confirmationMessage = `Attach "${customDomain}" to "${appName}"?`;
  } else {
    confirmationMessage = `Change "${appName}" custom domain from "${currentDomain}" to "${customDomain}"?`;
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage,
    pendingAction: {
      toolName: 'set_custom_domain',
      args: {
        app_name: app.name,
        leaseUuid: app.leaseUuid,
        serviceName,
        customDomain,
        currentDomain,
        expectedCnameTarget,
        warning,
        address,
      },
    },
  };
}

/**
 * Execute set_custom_domain after user confirmation.
 *
 * Delegates the broadcast to the SDK's `setItemCustomDomain` helper (from
 * `@manifest-network/manifest-sdk/deploy`, imported as `monoSetItemCustomDomain`,
 * which routes through `cosmosTx` + `set-item-custom-domain` CLI form) so validation,
 * canonicalization, and the result shape stay consistent with the MCP surface
 * and direct-CLI users.
 */
export async function executeConfirmedSetCustomDomain(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions,
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected.' };

  const appName = args.app_name as string;
  const leaseUuid = args.leaseUuid as string;
  const serviceName = typeof args.serviceName === 'string' ? args.serviceName : '';
  if (typeof args.customDomain !== 'string') {
    return { success: false, error: 'customDomain must be a string (use "" to clear).' };
  }
  const customDomain = args.customDomain;
  const expectedCnameTarget = typeof args.expectedCnameTarget === 'string' ? args.expectedCnameTarget : undefined;
  const isApexWarning = typeof args.warning === 'string' && args.warning.length > 0;
  const clearing = customDomain === '';

  if (typeof args.address === 'string' && args.address !== address) {
    return { success: false, error: 'Transaction cancelled: domain action address does not match the authorized wallet.' };
  }

  let result: Awaited<ReturnType<typeof monoSetItemCustomDomain>>;
  options.assertAuthorization?.();
  try {
    result = await monoSetItemCustomDomain(
      { chain: clientManager, logger: noopLogger },
      clearing
        ? {
            leaseUuid: asLeaseUuid(leaseUuid),
            clear: true,
            ...(serviceName !== '' ? { serviceName } : {}),
          }
          : {
              leaseUuid: asLeaseUuid(leaseUuid),
              customDomain: asFqdn(customDomain),
              ...(serviceName !== '' ? { serviceName } : {}),
            },
      {
        // Preserve Stop's pre-submission cancellation window. If cancellation
        // wins after broadcast, the transaction may still commit; the recurring
        // chain-domain reconciliation is the durable repair path across that
        // ambiguity, reloads, and disconnects.
        waitForConfirmation: true,
        signal: options.signal,
      },
    );
  } catch (err) {
    logError('compositeTransactions.executeConfirmedSetCustomDomain', err);
    return { success: false, error: err instanceof Error ? err.message : 'Failed to set custom domain.' };
  }

  if (result.code !== 0) {
    return { success: false, error: `Transaction failed with code ${result.code}.` };
  }

  // Refresh the AppEntry's customDomains cache so the polling driver can pick
  // up the new state without waiting for the next `app_status` call. Mirrors
  // the cache write in executeConfirmedDeployApp. Merge against the existing
  // cache: in a multi-service stack, attaching a domain to one service must
  // not clobber a domain previously attached to a different service.
  if (appRegistry) {
    const app = appRegistry.getAppByLease(address, leaseUuid);
    const prior = app?.customDomains ?? [];
    const others = prior.filter((d) => d.serviceName !== serviceName);
    const customDomains = clearing
      ? others
      : [...others, { serviceName, customDomain }];
    appRegistry.updateApp(address, leaseUuid, { customDomains });
  }

  if (clearing) {
    return {
      success: true,
      data: {
        message: `Custom domain cleared for "${appName}".`,
        app_name: appName,
        custom_domain: null,
        transactionHash: result.transactionHash,
      },
    };
  }

  const recordKind = isApexWarning
    ? `an ${apexRecordKindLabel(true)} record (apex domains cannot use CNAME)`
    : `a ${apexRecordKindLabel(false)}`;
  const target = expectedCnameTarget ?? '<provider FQDN>';

  return {
    success: true,
    data: {
      message: `Custom domain "${customDomain}" attached to "${appName}". Add ${recordKind} at your registrar pointing at ${target}.`,
      app_name: appName,
      custom_domain: customDomain,
      service_name: serviceName,
      expected_cname_target: expectedCnameTarget,
      is_apex: isApexWarning,
      transactionHash: result.transactionHash,
    },
    displayCard: {
      type: 'custom_domain',
      data: {
        appName,
        fqdn: customDomain,
        leaseUuid,
        serviceName,
        expectedCnameTarget,
        expectedAddress: address,
      },
    },
  };
}
