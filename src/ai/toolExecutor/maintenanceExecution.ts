import { asLeaseUuid } from '@manifest-network/manifest-sdk';
import { createMaintenanceIdempotencyKey, metaHashHex, restartApp, updateApp, waitForLeaseStatus } from '@manifest-network/manifest-sdk/deploy';
import { getLeaseProvision, getLeaseReleases } from '../../api/fred';
import { browserEventTransport } from '../../api/eventTransport';
import { AI_LEASE_WAIT_TIMEOUT_MS, FRED_POLL_INTERVAL_MS } from '../../config/constants';
import { runtimeConfig } from '../../config/runtimeConfig';
import { sanitizeManifestForStorage, type AppEntry } from '../../registry/appRegistry';
import { isAbortError } from '../../api/utils';
import { createProgressReporter } from '../progress';
import { sanitizeForDisplay } from '../../utils/sanitizeText';
import { buildBarneyCtx } from './capabilityCtx';
import { connectionPatch, resolveAppEndpoint } from './helpers';
import { resolveAppUrl } from './deployUrl';
import { validateManifestForProvider } from './deployArgs';
import { reconcileProvisionStatus } from './provisionStatus';
import { maintenanceRegistryPatch } from './maintenanceRegistryPatch';
import {
  assertMaintenanceOperationMatches,
  assertNewMaintenanceOperation,
  completeMaintenanceOperation,
  commitMaintenanceObservation,
  discardUnsubmittedMaintenanceOperation,
  getPendingMaintenanceOperation,
  markMaintenanceOperationAccepted,
  markMaintenanceOperationDispatched,
  prepareMaintenanceOperation,
  MaintenanceOperationRefusalError,
  MaintenanceOperationSupersededError,
  type MaintenanceOperation,
} from './maintenanceOperation';
import { captureMaintenanceBaseline, evaluateMaintenanceOutcome } from './maintenanceOutcome';
import {
  captureMaintenanceCompletionEpoch, getCompletedMaintenance, isMaintenanceCompletionEpochCurrent,
  MAINTENANCE_CAPACITY_MESSAGE, releaseMaintenanceCompletionReservation, rememberMaintenanceCompletion,
  reserveMaintenanceCompletions, type MaintenanceCompletionReservation, type MaintenanceResult,
} from './maintenanceCompletion';
import { settledMaintenanceRefusal } from './maintenanceRefusal';
import type { ToolExecutorOptions } from './types';

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
    expectPending?: boolean;
    previousOperationKey?: string;
  },
  options: ToolExecutorOptions,
): Promise<MaintenanceResult> {
  const { address, signing, clientManager, appRegistry, signal } = options;
  if (!address || !signing || !clientManager || !appRegistry) {
    return { outcome: 'failed', result: { success: false, error: 'Wallet and app registry are required.' } };
  }
  const { operation, app_name: name, leaseUuid, providerUrl } = input;
  const chainId = options.authorization?.chainId ?? runtimeConfig.PUBLIC_CHAIN_ID;
  const completionEpoch = captureMaintenanceCompletionEpoch({ address, chainId });
  const assertCurrent = () => {
    options.assertAuthorization?.();
    signal?.throwIfAborted();
    if (!isMaintenanceCompletionEpochCurrent(completionEpoch)) throw new Error('This maintenance confirmation is no longer current.');
  };
  const verb = operation === 'restart' ? 'Restart' : 'Update';
  const onProgress = createProgressReporter(options.onProgress);
  const token = () => signing.authTokens.getAuthToken(asLeaseUuid(leaseUuid));
  let command: Readonly<MaintenanceOperation> | undefined;
  let existedBeforeAttempt = false;
  let created = false;
  let dispatchStarted = false;
  let accepted = false;
  let localDispatchError: unknown;
  let recoveryKey = input.idempotencyKey;
  let reservation: MaintenanceCompletionReservation | undefined;
  const observationOnly = (detail: string): MaintenanceResult => {
    const guidance = `${verb} observation for "${name}": ${detail} ` +
      `Check app_status("${name}") and app_releases("${name}") to observe the current state.`;
    onProgress({ phase: 'unconfirmed', operation, detail: 'Observe the current app state' });
    return { outcome: 'unconfirmed', result: { success: false, error: guidance } };
  };
  const unconfirmed = async (detail: string): Promise<MaintenanceResult> => {
    try {
      const saved = getPendingMaintenanceOperation(address, providerUrl, leaseUuid, chainId);
      if (!saved || saved.operation !== operation || saved.idempotencyKey !== recoveryKey) {
        return observationOnly('This browser no longer has the original pending record; another tab may have settled or superseded it. This response alone cannot establish its outcome.');
      }
      try {
        const observed = await commitMaintenanceObservation(saved, {
          settled: false,
          isCurrent: () => {
            options.assertAuthorization?.();
            return isMaintenanceCompletionEpochCurrent(completionEpoch);
          },
          apply: () => {
            const current = appRegistry.getAppByLease(address, leaseUuid);
            if (current?.providerUrl === providerUrl && current.chainState !== 'absent') {
              // Retain the readiness badge, but let bounded background recovery
              // observe work that can finish after this request was cancelled.
              appRegistry.updateApp(address, leaseUuid, { connectionStale: true });
            }
          },
        });
        if (!observed) return observationOnly('The saved command changed while this response was being prepared. Observe its current result before deciding whether another command is needed.');
      } catch {
        // A stale UI session must not erase the retained provider command.
      }
    } catch {
      return observationOnly(`${detail} The saved command could not be read. Restore browser storage access before further recovery.`);
    }
    const guidance = `${verb} outcome for "${name}" is unconfirmed. ${detail} ` +
      `Check app_status("${name}") and app_releases("${name}"). ` +
      `Retry ${operation}_app(app_name="${name}") to recover the saved command with its original key and exact payload. ` +
      'Do not submit a new command or automatically stop/redeploy to recover this outcome.';
    onProgress({ phase: 'unconfirmed', operation, detail: `${verb} outcome unconfirmed` });
    return { outcome: 'unconfirmed', result: { success: false, error: guidance } };
  };

  try {
    const priorResult = input.idempotencyKey
      ? getCompletedMaintenance({ ...input, address, chainId, idempotencyKey: input.idempotencyKey })
      : undefined;
    if (priorResult) {
      assertCurrent();
      if (priorResult.payloadHash !== await metaHashHex(input.manifest ?? '')) {
        return { outcome: 'failed', result: { success: false, error: 'A command key cannot be reused with different payload bytes.' } };
      }
      assertCurrent();
      onProgress({ phase: priorResult.result.outcome === 'succeeded' ? 'ready' : priorResult.result.outcome === 'failed' ? 'failed' : 'unconfirmed', operation, detail: priorResult.result.result.error });
      return priorResult.result;
    }
    const pending = getPendingMaintenanceOperation(address, providerUrl, leaseUuid, chainId);
    if (pending) assertMaintenanceOperationMatches(pending, input);
    else if (input.expectPending) {
      throw new MaintenanceOperationSupersededError('The saved maintenance operation no longer exists; it may have been settled or superseded in another tab.');
    }
    else assertNewMaintenanceOperation({ ...input, address, chainId });
    recoveryKey = pending?.idempotencyKey ?? recoveryKey ?? createMaintenanceIdempotencyKey();
    reservation = reserveMaintenanceCompletions([{
      address, chainId, providerUrl, leaseUuid, operation, idempotencyKey: recoveryKey, recovery: !!pending,
    }], completionEpoch);
    if (!reservation) throw new MaintenanceOperationRefusalError(MAINTENANCE_CAPACITY_MESSAGE);
    existedBeforeAttempt = pending !== undefined;
    assertCurrent();
    if (pending && input.manifest !== undefined && pending.payloadHash !== await metaHashHex(input.manifest)) {
      return unconfirmed('This retry has different manifest bytes from the saved command and was not sent.');
    }
    if (operation === 'update') {
      const validationError = await validateManifestForProvider(input.manifest ?? '', providerUrl);
      if (validationError) throw new Error(validationError);
    }
    // A replay can acknowledge an old pending command while the source is still
    // ready. Only releases newer than the ORIGINAL pre-dispatch snapshot count.
    const baseline = pending?.baselineReleaseVersions ??
      captureMaintenanceBaseline(await getLeaseReleases(providerUrl, leaseUuid, await token()));
    const prepared = await prepareMaintenanceOperation({
      address, providerUrl, leaseUuid, operation, chainId,
      idempotencyKey: recoveryKey,
      manifest: input.manifest,
      previousManifest: appRegistry.getAppByLease(address, leaseUuid)?.manifest,
      baselineReleaseVersions: baseline,
      expectPending: input.expectPending || existedBeforeAttempt,
      previousOperationKey: input.previousOperationKey,
    });
    command = prepared.command;
    recoveryKey = command.idempotencyKey;
    created = prepared.created;
    const registrySnapshot = structuredClone(appRegistry.getAppByLease(address, leaseUuid));
    const ctx = await buildBarneyCtx(clientManager, signing, { events: browserEventTransport });
    const maintenanceCtx = {
      ...ctx,
      fetch: async (...args: Parameters<typeof ctx.fetch>) => {
        // Persist the handoff before HTTP, under the same cross-tab lock as
        // cancellation cleanup. A local failure cannot delete another sender's
        // recovery handle. SDK authentication and recovery wrapping stay intact.
        try {
          assertCurrent();
          await markMaintenanceOperationDispatched(prepared.command, assertCurrent);
          assertCurrent();
        } catch (error) {
          // The SDK wraps injected-fetch errors as transport uncertainty. Keep
          // local cancellation identity for a safely discarded new command.
          localDispatchError = error;
          throw error;
        }
        dispatchStarted = true;
        return ctx.fetch(...args);
      },
    };
    onProgress({ phase: operation === 'restart' ? 'restarting' : 'updating', operation, detail: `${verb} requested...` });
    assertCurrent();
    const callOptions = { pollOptions: false as const, providerUrl, signal, idempotencyKey: command.idempotencyKey, fredCompatibility: 'pr240' as const };
    // SDK mints fresh ADR-036 authentication for every invocation, including
    // exact retries; it also retains the command handle in structured errors.
    if (operation === 'restart') {
      await restartApp(maintenanceCtx, { address, leaseUuid }, callOptions);
    } else {
      await updateApp(maintenanceCtx, { address, leaseUuid, manifest: command.manifest! }, callOptions);
    }
    accepted = true;
    try {
      await markMaintenanceOperationAccepted(command);
    } catch (error) {
      // Another tab can settle the command before this response arrives. Its
      // removed marker does not erase this attempt's immutable read baseline.
      if (!(error instanceof MaintenanceOperationSupersededError)) throw error;
    }
    onProgress({ phase: 'provisioning', operation, detail: 'Waiting for runtime and operation outcome...' });
    let status;
    try {
      status = await waitForLeaseStatus(ctx, asLeaseUuid(leaseUuid), {
        timeout: AI_LEASE_WAIT_TIMEOUT_MS,
        intervalMs: FRED_POLL_INTERVAL_MS,
        signal,
        onStatus: (fredStatus) => onProgress({ phase: 'provisioning', operation, fredStatus, detail: fredStatus.phase || 'Waiting for maintenance...' }),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      // A failed readiness wait can still have a definite command verdict.
      // Fresh reads below distinguish failed replacement from missing evidence.
    }
    signal?.throwIfAborted();
    const [provisionRead, releasesRead] = await Promise.allSettled([
      token().then((auth) => { signal?.throwIfAborted(); return getLeaseProvision(providerUrl, leaseUuid, auth); }),
      token().then((auth) => { signal?.throwIfAborted(); return getLeaseReleases(providerUrl, leaseUuid, auth); }),
    ]);
    signal?.throwIfAborted();
    const provision = provisionRead.status === 'fulfilled' ? provisionRead.value : undefined;
    const releases = releasesRead.status === 'fulfilled' ? releasesRead.value : undefined;
    const verdict = evaluateMaintenanceOutcome({ baselineVersions: command.baselineReleaseVersions, provision, releases });

    // Runtime health is useful even if the requested replacement failed and
    // Fred compensated by bringing the old runtime back online.
    let url: string | undefined;
    const patch: Partial<AppEntry> = {};
    if (verdict.runtimeReady) {
      const endpoint = status
        ? await resolveAppUrl(providerUrl, leaseUuid, status, address, signing, 'maintenanceExecution')
        : { url: undefined, connection: undefined };
      const previous = appRegistry.getAppByLease(address, leaseUuid);
      url = endpoint.url ?? (previous ? resolveAppEndpoint(previous) : undefined);
      Object.assign(patch, {
        provisionState: 'confirmed',
        ...connectionPatch({ url: endpoint.url, connection: endpoint.connection, connectionStale: !endpoint.connection }, previous),
      });
    } else if (provision) {
      const provisionState = reconcileProvisionStatus(provision.status, appRegistry.getAppByLease(address, leaseUuid)?.provisionState);
      if (provisionState) patch.provisionState = provisionState;
    }
    signal?.throwIfAborted();
    const settled = verdict.outcome !== 'unconfirmed';
    if (settled && operation === 'update' && (verdict.outcome === 'succeeded' || command.previousManifest !== undefined)) {
      patch.manifest = verdict.outcome === 'succeeded' ? sanitizeManifestForStorage(command.manifest!) : command.previousManifest;
    }
    const failure = `${verb} failed${verdict.runtimeReady ? '; the previous runtime is healthy' : ''}. ${verdict.detail ?? ''}`.trim();
    const result: MaintenanceResult | undefined = !settled ? undefined : verdict.outcome === 'failed'
      ? { outcome: 'failed', result: { success: false, error: failure } }
      : { outcome: 'succeeded', url, result: { success: true, data: {
        message: `App "${name}" has been ${operation === 'restart' ? 'restarted' : 'updated'}.`, name, url, status: 'running',
      } } };
    const applied = await commitMaintenanceObservation(command, {
      settled,
      ...(settled && { outcome: verdict.outcome as 'succeeded' | 'failed' }),
      isCurrent: () => {
        assertCurrent();
        return true;
      },
      apply: () => {
        // Registry freshness controls only this projection, not the independently
        // verified command verdict or retirement of its still-current marker.
        const currentPatch = maintenanceRegistryPatch(registrySnapshot, appRegistry.getAppByLease(address, leaseUuid), patch);
        if (Object.keys(currentPatch).length > 0) {
          appRegistry.updateApp(address, leaseUuid, currentPatch);
        }
      },
    });
    assertCurrent();
    if (result) {
      rememberMaintenanceCompletion(command, result, completionEpoch);
      onProgress({ phase: result.outcome === 'succeeded' ? 'ready' : 'failed', operation, detail: result.result.error });
      return result;
    }
    if (!applied) {
      const prior = getCompletedMaintenance(command);
      if (prior) {
        onProgress({ phase: prior.result.outcome === 'succeeded' ? 'ready' : prior.result.outcome === 'failed' ? 'failed' : 'unconfirmed', operation, detail: prior.result.result.error });
        return prior.result;
      }
      return observationOnly('The saved command changed during verification and may have been settled or superseded in another tab. This view could not establish its outcome.');
    }
    return unconfirmed(verdict.detail ?? 'The provider has not established a settled command result.');
  } catch (error) {
    if (error instanceof MaintenanceOperationSupersededError || localDispatchError instanceof MaintenanceOperationSupersededError) {
      const detail = (localDispatchError instanceof MaintenanceOperationSupersededError ? localDispatchError : error) as MaintenanceOperationSupersededError;
      return observationOnly(`${dispatchStarted ? 'No further maintenance request was sent.' : input.expectPending ? 'This recovery request was not sent.' : 'This maintenance request was not sent.'} ${detail.message}`);
    }
    if (error instanceof MaintenanceOperationRefusalError) {
      onProgress({ phase: 'failed', operation, detail: error.message });
      return { outcome: 'failed', result: { success: false, error: error.message } };
    }
    // Only a newly created command with no HTTP handoff can be discarded.
    // On an existing command even a local abort cannot undo an earlier attempt.
    if (command && created && !accepted && !dispatchStarted) {
      try {
        if (await discardUnsubmittedMaintenanceOperation(command)) command = undefined;
      } catch {
        return unconfirmed('The request did not start, but its recovery record could not be safely cleared. Restore browser storage access before retrying.');
      }
    }
    const refusal = command && settledMaintenanceRefusal(error, command);
    if (command && refusal) {
      let retirementFailed = false;
      try {
        // An authoritative receipt remains valid after Esc, wallet changes, or
        // chat invalidation. Identity matching protects any successor command.
        await completeMaintenanceOperation(command, undefined, 'failed');
      } catch {
        retirementFailed = true;
      }
      const safeRefusal = sanitizeForDisplay(refusal, 512);
      const detail = `${verb} failed: ${safeRefusal}${/[.!?…]$/.test(safeRefusal) ? '' : '.'}` +
        (retirementFailed ? ' Its local recovery record could not be cleared. Restore browser storage access before starting another command.' : '');
      const result: MaintenanceResult = { outcome: 'failed', result: { success: false, error: detail } };
      try {
        options.assertAuthorization?.();
        if (isMaintenanceCompletionEpochCurrent(completionEpoch)) {
          rememberMaintenanceCompletion(command, result, completionEpoch);
          onProgress({ phase: 'failed', operation, detail });
        }
      } catch {
        // The old wallet's receipt can retire its marker without updating the
        // new session's cache or progress UI.
      }
      return result;
    }
    if (command || existedBeforeAttempt) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const detail = code === 'MAINTENANCE_REQUEST_FAILED'
        ? 'The request was refused or conflicted; an earlier attempt may still be pending.'
        : accepted ? 'Readiness or command verification did not establish completion.'
          : 'The provider may retain a pending command that executes later.';
      return unconfirmed(detail);
    }
    const preparationError = localDispatchError ?? error;
    if (isAbortError(preparationError)) return { outcome: 'cancelled', result: { success: false, error: `${verb} cancelled before dispatch.` } };
    return { outcome: 'failed', result: { success: false, error: preparationError instanceof Error ? preparationError.message : `${verb} could not be prepared.` } };
  } finally {
    if (reservation) {
      let retainPending = false;
      try {
        const saved = getPendingMaintenanceOperation(address, providerUrl, leaseUuid, chainId);
        retainPending = !!saved && saved.idempotencyKey === recoveryKey && !!saved.dispatched;
      } catch {
        // A dispatched request with unreadable metadata still owns its slot.
        retainPending = dispatchStarted || existedBeforeAttempt;
      }
      releaseMaintenanceCompletionReservation(reservation, retainPending);
    }
  }
}
