import { asLeaseUuid } from '@manifest-network/manifest-sdk';
import { restartApp, updateApp, waitForLeaseStatus } from '@manifest-network/manifest-sdk/deploy';
import { getLeaseProvision, getLeaseReleases } from '../../api/fred';
import { browserEventTransport } from '../../api/eventTransport';
import { AI_LEASE_WAIT_TIMEOUT_MS, FRED_POLL_INTERVAL_MS } from '../../config/constants';
import { runtimeConfig } from '../../config/runtimeConfig';
import { sanitizeManifestForStorage } from '../../registry/appRegistry';
import { isAbortError } from '../../api/utils';
import { createProgressReporter } from '../progress';
import { buildBarneyCtx } from './capabilityCtx';
import { connectionPatch, resolveAppEndpoint } from './helpers';
import { resolveAppUrl } from './deployUrl';
import { validateManifestForProvider } from './deployArgs';
import { classifyProvisionStatus } from './provisionStatus';
import {
  completeMaintenanceOperation,
  getOrCreateMaintenanceOperation,
  getPendingMaintenanceOperation,
  type MaintenanceOperation,
} from './maintenanceOperation';
import { captureMaintenanceBaseline, evaluateMaintenanceOutcome } from './maintenanceOutcome';
import type { ToolExecutorOptions, ToolResult } from './types';

type MaintenanceResult = {
  outcome: 'succeeded' | 'failed' | 'unconfirmed' | 'cancelled';
  result: ToolResult;
  url?: string;
};

// A repeated confirmation of an already settled plan is the same logical
// action. Do not run a second observation against a new release baseline.
const completed = new Map<string, { result: MaintenanceResult; manifest?: string }>();

/** PR 240 commands are durable. Preserve their identity until command outcome,
 * independently of runtime health, has been established. Never auto-retry a POST. */
export async function executeMaintenance(
  input: {
    operation: 'restart' | 'update';
    app_name: string;
    leaseUuid: string;
    providerUrl: string;
    idempotencyKey?: string;
    manifest?: string;
  },
  options: ToolExecutorOptions,
): Promise<MaintenanceResult> {
  const { address, signing, clientManager, appRegistry, signal } = options;
  if (!address || !signing || !clientManager || !appRegistry) {
    return { outcome: 'failed', result: { success: false, error: 'Wallet and app registry are required.' } };
  }
  const { operation, app_name: name, leaseUuid, providerUrl } = input;
  const chainId = options.authorization?.chainId ?? runtimeConfig.PUBLIC_CHAIN_ID;
  const completionKey = input.idempotencyKey
    ? JSON.stringify([chainId, address, providerUrl, leaseUuid, operation, input.idempotencyKey])
    : undefined;
  const priorResult = completionKey ? completed.get(completionKey) : undefined;
  if (priorResult) return priorResult.manifest === input.manifest
    ? priorResult.result
    : { outcome: 'failed', result: { success: false, error: 'A command key cannot be reused with different payload bytes.' } };
  const verb = operation === 'restart' ? 'Restart' : 'Update';
  const onProgress = createProgressReporter(options.onProgress);
  const token = () => signing.authTokens.getAuthToken(asLeaseUuid(leaseUuid));
  let command: Readonly<MaintenanceOperation> | undefined;
  let accepted = false;
  const unconfirmed = (detail: string): MaintenanceResult => {
    const guidance = `${verb} outcome for "${name}" is unconfirmed. ${detail} ` +
      `Check app_status("${name}") and app_releases("${name}"). ` +
      `Retry ${operation}_app(app_name="${name}") to recover the saved command with its original key and exact payload. ` +
      'Do not submit a new command or stop/redeploy while this outcome is unresolved.';
    onProgress({ phase: 'failed', operation, detail: `${verb} outcome unconfirmed` });
    return { outcome: 'unconfirmed', result: { success: false, error: guidance } };
  };

  try {
    options.assertAuthorization?.();
    signal?.throwIfAborted();
    if (operation === 'update') {
      const validationError = await validateManifestForProvider(input.manifest ?? '', providerUrl);
      if (validationError) throw new Error(validationError);
    }
    const pending = getPendingMaintenanceOperation(address, providerUrl, leaseUuid, chainId);
    // A replay can acknowledge an old pending command while the source is still
    // ready. Only releases newer than the ORIGINAL pre-dispatch snapshot count.
    const baseline = pending?.baselineReleaseVersions ??
      captureMaintenanceBaseline(await getLeaseReleases(providerUrl, leaseUuid, await token()));
    command = await getOrCreateMaintenanceOperation({
      address, providerUrl, leaseUuid, operation, chainId,
      idempotencyKey: input.idempotencyKey,
      manifest: input.manifest,
      previousManifest: appRegistry.getAppByLease(address, leaseUuid)?.manifest,
      baselineReleaseVersions: baseline,
    });
    const ctx = await buildBarneyCtx(clientManager, signing, { events: browserEventTransport });
    onProgress({ phase: operation === 'restart' ? 'restarting' : 'updating', operation, detail: `${verb} requested...` });
    options.assertAuthorization?.();
    const callOptions = { pollOptions: false as const, providerUrl, signal, idempotencyKey: command.idempotencyKey, fredCompatibility: 'pr240' as const };
    // SDK mints fresh ADR-036 authentication for every invocation, including
    // exact retries; it also retains the command handle in structured errors.
    if (operation === 'restart') {
      await restartApp(ctx, { address, leaseUuid }, callOptions);
    } else {
      await updateApp(ctx, { address, leaseUuid, manifest: command.manifest! }, callOptions);
    }
    accepted = true;
    onProgress({ phase: 'provisioning', operation, detail: 'Waiting for runtime and operation outcome...' });
    let status;
    try {
      status = await waitForLeaseStatus(ctx, asLeaseUuid(leaseUuid), {
        timeout: AI_LEASE_WAIT_TIMEOUT_MS,
        intervalMs: FRED_POLL_INTERVAL_MS,
        signal,
        onStatus: (fredStatus) => onProgress({ phase: 'provisioning', operation, fredStatus, detail: fredStatus.phase || 'Waiting for maintenance...' }),
      });
    } catch {
      // A failed readiness wait can still have a definite command verdict.
      // Fresh reads below distinguish failed replacement from missing evidence.
    }
    const [provisionRead, releasesRead] = await Promise.allSettled([
      token().then((auth) => getLeaseProvision(providerUrl, leaseUuid, auth)),
      token().then((auth) => getLeaseReleases(providerUrl, leaseUuid, auth)),
    ]);
    const provision = provisionRead.status === 'fulfilled' ? provisionRead.value : undefined;
    const releases = releasesRead.status === 'fulfilled' ? releasesRead.value : undefined;
    const verdict = evaluateMaintenanceOutcome({ baselineVersions: command.baselineReleaseVersions, provision, releases });

    // Runtime health is useful even if the requested replacement failed and
    // Fred compensated by bringing the old runtime back online.
    let url: string | undefined;
    if (verdict.runtimeReady) {
      const endpoint = status
        ? await resolveAppUrl(providerUrl, leaseUuid, status, address, signing, 'maintenanceExecution')
        : { url: undefined, connection: undefined };
      const previous = appRegistry.getAppByLease(address, leaseUuid);
      url = endpoint.url ?? (previous ? resolveAppEndpoint(previous) : undefined);
      appRegistry.updateApp(address, leaseUuid, {
        provisionState: 'confirmed',
        ...connectionPatch({ url: endpoint.url, connection: endpoint.connection, connectionStale: !endpoint.connection }, previous),
      });
    } else if (provision) {
      const provisionState = classifyProvisionStatus(provision.status);
      if (provisionState) appRegistry.updateApp(address, leaseUuid, { provisionState });
    }
    if (verdict.outcome === 'unconfirmed') return unconfirmed(verdict.detail ?? 'The provider has not established a settled command result.');
    if (operation === 'update') {
      appRegistry.updateApp(address, leaseUuid, {
        manifest: verdict.outcome === 'succeeded' ? sanitizeManifestForStorage(command.manifest!) : command.previousManifest,
      });
    }
    await completeMaintenanceOperation(command);
    if (verdict.outcome === 'failed') {
      const detail = `${verb} failed${verdict.runtimeReady ? '; the previous runtime is healthy' : ''}. ${verdict.detail ?? ''}`.trim();
      onProgress({ phase: 'failed', operation, detail });
      const result: MaintenanceResult = { outcome: 'failed', result: { success: false, error: detail } };
      if (completionKey) completed.set(completionKey, { result, manifest: input.manifest });
      return result;
    }
    onProgress({ phase: 'ready', operation });
    const result: MaintenanceResult = { outcome: 'succeeded', url, result: { success: true, data: {
      message: `App "${name}" has been ${operation === 'restart' ? 'restarted' : 'updated'}.`, name, url, status: 'running',
    } } };
    if (completionKey) completed.set(completionKey, { result, manifest: input.manifest });
    return result;
  } catch (error) {
    // A plain SDK abort happens before dispatch. POST failures (including abort,
    // 409, timeout/503, lost response and persistence 500) have maintenance codes.
    // On an existing command even a local abort cannot undo an earlier attempt.
    if (command) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const detail = code === 'MAINTENANCE_REQUEST_FAILED'
        ? 'The request was refused or conflicted; an earlier attempt may still be pending.'
        : accepted ? 'Readiness or command verification did not establish completion.'
          : 'The provider may retain a pending command that executes later.';
      return unconfirmed(detail);
    }
    if (isAbortError(error)) return { outcome: 'cancelled', result: { success: false, error: `${verb} cancelled before dispatch.` } };
    return { outcome: 'failed', result: { success: false, error: error instanceof Error ? error.message : `${verb} could not be prepared.` } };
  }
}
