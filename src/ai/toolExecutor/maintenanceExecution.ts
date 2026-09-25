import { asLeaseUuid } from '@manifest-network/manifest-sdk';
import { createMaintenanceIdempotencyKey, metaHashHex, ProviderApiError, restartApp, updateApp, waitForLeaseStatus } from '@manifest-network/manifest-sdk/deploy';
import { getLeaseProvision, getLeaseReleases } from '../../api/fred';
import { browserEventTransport } from '../../api/eventTransport';
import { AI_LEASE_WAIT_TIMEOUT_MS, AI_MAINTENANCE_PREPARATION_DETAIL_CHARS, FRED_POLL_INTERVAL_MS } from '../../config/constants';
import { runtimeConfig } from '../../config/runtimeConfig';
import { sanitizeManifestForStorage } from '../../registry/appRegistry';
import { isAbortError } from '../../api/utils';
import { createProgressReporter } from '../progress';
import { sanitizeForDisplay } from '../../utils/sanitizeText';
import { finishDisplaySentence } from '../../utils/displaySentence';
import { buildBarneyCtx } from './capabilityCtx';
import { connectionPatch, FAILURE_DETAIL_CHARS, resolveAppEndpoint } from './helpers';
import { resolveAppUrl } from './deployUrl';
import { validateManifestForProvider } from './deployArgs';
import { maintenanceReadinessPatch } from './maintenanceReadiness';
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
  markMaintenanceRecoveryAdvised,
  prepareMaintenanceOperation,
  MaintenanceOperationRefusalError,
  MaintenanceOperationSupersededError,
  MaintenanceSettlementStorageError,
  MAINTENANCE_CLEANUP_MESSAGE,
  type MaintenanceOperation,
} from './maintenanceOperation';
import { captureMaintenanceBaseline, evaluateMaintenanceOutcome } from './maintenanceOutcome';
import {
  captureMaintenanceCompletionEpoch, getCompletedMaintenance, isMaintenanceCompletionEpochCurrent,
  MAINTENANCE_CAPACITY_MESSAGE, releaseMaintenanceCompletionReservation, rememberMaintenanceCompletion,
  reserveMaintenanceCompletions, type MaintenanceCompletionReservation, type MaintenanceResult,
} from './maintenanceCompletion';
import { settledMaintenanceRefusal } from './maintenanceRefusal';
import { consumeMaintenanceRecoveryIntent, rememberMaintenanceRecoveryIntent, maintenanceRecoveryAdvice } from './maintenanceRecoveryIntent';
import type { ToolExecutorOptions } from './types';

function withCleanupWarning(value: MaintenanceResult, warning = MAINTENANCE_CLEANUP_MESSAGE): MaintenanceResult {
  const failure = value.result.error ?? 'Maintenance failed.';
  if (!value.result.success) return { ...value, result: { success: false,
    error: `${finishDisplaySentence(failure)} ${warning}` } };
  const data = value.result.data && typeof value.result.data === 'object' ? value.result.data as Record<string, unknown> : {};
  return { ...value, result: { success: true, data: { ...data, localCleanupPending: true,
    message: `${typeof data.message === 'string' ? data.message : 'Maintenance succeeded.'} ${warning}` } } };
}

function withReplayNotice(value: MaintenanceResult, operation: 'restart' | 'update', name: string): MaintenanceResult {
  const notice = `Previously verified ${operation} of "${name}": ${value.outcome}. No new maintenance request was sent.`;
  if (!value.result.success) return { ...value, result: { ...value.result, error: `${notice} ${value.result.error ?? ''}`.trim() } };
  const data = value.result.data && typeof value.result.data === 'object' ? value.result.data as Record<string, unknown> : {};
  return { ...value, result: { success: true, data: { ...data, replayed: true, message: notice } } };
}

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
    recoveryIntentKey?: string;
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
  const observationOnly = async (detail: string): Promise<MaintenanceResult> => {
    if (command) {
      try { await markMaintenanceRecoveryAdvised(command, options.onMaintenanceRecoveryAdvice); } catch { /* Keep observation-only advice when storage is unavailable. */ }
    }
    const guidance = `${verb} observation for "${name}": ${detail} ` +
      `Check app_status("${name}") and app_releases("${name}") to observe the current state.`;
    onProgress({ phase: 'unconfirmed', operation, detail: 'Observe the current app state' });
    return { outcome: 'unconfirmed', result: { success: false, error: guidance } };
  };
  const unconfirmed = async (detail: string): Promise<MaintenanceResult> => {
    try {
      const saved = getPendingMaintenanceOperation(address, providerUrl, leaseUuid, chainId);
      if (!saved || saved.operation !== operation || saved.idempotencyKey !== recoveryKey) {
        return observationOnly(`${detail} ${dispatchStarted
          ? 'This attempt submitted a maintenance request; the provider may still retain a pending command.'
          : 'This attempt sent no maintenance request; an earlier command may still remain pending at the provider.'} ` +
          'This browser no longer has the original pending record; another tab may have settled or superseded it.');
      }
      await markMaintenanceRecoveryAdvised(saved, options.onMaintenanceRecoveryAdvice);
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
              appRegistry.updateApp(address, leaseUuid, { readinessStale: true, connectionStale: true });
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
      let cleanupFailed = false;
      let cleanupCommand: Readonly<MaintenanceOperation> | undefined;
      try {
        const saved = getPendingMaintenanceOperation(address, providerUrl, leaseUuid, chainId);
        if (saved && saved.idempotencyKey === input.idempotencyKey && saved.operation === operation
          && saved.payloadHash === priorResult.payloadHash
          && (priorResult.result.outcome === 'succeeded' || priorResult.result.outcome === 'failed')) {
          cleanupCommand = saved;
          await completeMaintenanceOperation(saved, undefined, priorResult.result.outcome);
        }
      } catch { cleanupFailed = true; }
      if (cleanupFailed) {
        rememberMaintenanceRecoveryIntent({ address, chainId, providerUrl, leaseUuid, operation, idempotencyKey: input.idempotencyKey! });
        if (cleanupCommand) await markMaintenanceRecoveryAdvised(cleanupCommand, options.onMaintenanceRecoveryAdvice);
        else options.onMaintenanceRecoveryAdvice?.(maintenanceRecoveryAdvice({ address, chainId, providerUrl, leaseUuid, operation, idempotencyKey: input.idempotencyKey! }));
      }
      try { assertCurrent(); } catch {
        return { outcome: 'cancelled', result: { success: false,
          error: `Recovery cancelled. The previous ${operation} outcome remains verified as ${priorResult.result.outcome}. No new maintenance request was sent.` } };
      }
      const replay = withReplayNotice(priorResult.result, operation, name);
      const result = cleanupFailed ? withCleanupWarning(replay) : replay;
      onProgress({ phase: result.outcome === 'succeeded' ? 'ready' : result.outcome === 'failed' ? 'failed' : 'unconfirmed', operation,
        detail: cleanupFailed ? MAINTENANCE_CLEANUP_MESSAGE : result.result.error ?? (result.result.data as { message?: string } | undefined)?.message });
      return result;
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
      if (validationError) return { outcome: 'failed', result: { success: false, error: `${verb} could not be prepared: ${validationError}` } };
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
      recoveryIntentKey: input.recoveryIntentKey,
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
        const request = ctx.fetch(...args);
        try { consumeMaintenanceRecoveryIntent(prepared.command, input.recoveryIntentKey); } catch { /* Keep observing the submitted request if tab storage becomes unreadable. */ }
        return request;
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
    // The wait's runtime verdict remains useful when the subsequent read fails.
    // A successful fresh read, including progress, always supersedes it.
    const provision = provisionRead.status === 'fulfilled' ? provisionRead.value
      : status?.provision_status ? { ...status, status: status.provision_status, fail_count: status.fail_count ?? 0 } : undefined;
    const releases = releasesRead.status === 'fulfilled' ? releasesRead.value : undefined;
    const verdict = evaluateMaintenanceOutcome({ baselineVersions: command.baselineReleaseVersions, provision, releases });

    // Runtime health is useful even if the requested replacement failed and
    // Fred compensated by bringing the old runtime back online.
    let url: string | undefined;
    const patch = maintenanceReadinessPatch(provision?.status, registrySnapshot);
    if (verdict.runtimeReady) {
      const endpoint = status
        ? await resolveAppUrl(providerUrl, leaseUuid, status, address, signing, 'maintenanceExecution')
        : { url: undefined, connection: undefined };
      const previous = appRegistry.getAppByLease(address, leaseUuid);
      url = endpoint.url ?? (previous ? resolveAppEndpoint(previous) : undefined);
      Object.assign(patch, {
        ...connectionPatch({ url: endpoint.url, connection: endpoint.connection, connectionStale: !endpoint.connection }, previous),
      });
    } else if (patch.readinessStale) {
      // Releases can prove the command failed while runtime readiness remains
      // unknown. Keep observing that independent outcome after this call ends.
      patch.connectionStale = true;
    }
    signal?.throwIfAborted();
    const settled = verdict.outcome !== 'unconfirmed';
    if (settled && operation === 'update' && (verdict.outcome === 'succeeded' || command.previousManifest !== undefined)) {
      patch.manifest = verdict.outcome === 'succeeded' ? sanitizeManifestForStorage(command.manifest!) : command.previousManifest;
    }
    const failureDetail = `${verb} failed${verdict.runtimeReady ? '; the previous runtime is healthy' : ''}. ${verdict.detail ?? ''}`.trim();
    const failure = finishDisplaySentence(failureDetail);
    const result: MaintenanceResult | undefined = !settled ? undefined : verdict.outcome === 'failed'
      ? { outcome: 'failed', result: { success: false, error: failure } }
      : { outcome: 'succeeded', url, result: { success: true, data: {
        message: `App "${name}" has been ${operation === 'restart' ? 'restarted' : 'updated'}.`, name, url, status: 'running',
      } } };
    let cleanupWarning: string | undefined;
    let projectionApplied = true;
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
    }).catch((error: unknown) => {
      if (!(error instanceof MaintenanceSettlementStorageError)) throw error;
      cleanupWarning = error.message;
      projectionApplied = error.projectionApplied;
      return true; // The outcome remains verified; track skipped projection separately.
    });
    assertCurrent();
    if (result) {
      if (cleanupWarning) await markMaintenanceRecoveryAdvised(command, options.onMaintenanceRecoveryAdvice);
      try {
        assertCurrent();
        if (projectionApplied) rememberMaintenanceCompletion(command, result, completionEpoch);
        onProgress({ phase: result.outcome === 'succeeded' ? 'ready' : 'failed', operation,
          detail: cleanupWarning ?? result.result.error });
      } catch { /* A late storage lock must not update an invalidated UI session. */ }
      return cleanupWarning ? withCleanupWarning(result, cleanupWarning) : result;
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
      if (error.command) await markMaintenanceRecoveryAdvised(error.command, options.onMaintenanceRecoveryAdvice);
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
      if (retirementFailed) await markMaintenanceRecoveryAdvised(command, options.onMaintenanceRecoveryAdvice);
      const safeRefusal = sanitizeForDisplay(refusal, 512);
      const detail = finishDisplaySentence(`${verb} failed: ${safeRefusal}`);
      const result: MaintenanceResult = { outcome: 'failed', result: { success: false, error: detail } };
      try {
        options.assertAuthorization?.();
        if (isMaintenanceCompletionEpochCurrent(completionEpoch)) {
          rememberMaintenanceCompletion(command, result, completionEpoch);
          onProgress({ phase: 'failed', operation, detail: retirementFailed ? `${detail} ${MAINTENANCE_CLEANUP_MESSAGE}` : detail });
        }
      } catch {
        // The old wallet's receipt can retire its marker without updating the
        // new session's cache or progress UI.
      }
      return retirementFailed ? withCleanupWarning(result) : result;
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
    const detail = preparationError instanceof Error
      ? ProviderApiError.isProviderApiError(preparationError)
        ? sanitizeForDisplay(preparationError.message, FAILURE_DETAIL_CHARS)
        : sanitizeForDisplay(preparationError.message, AI_MAINTENANCE_PREPARATION_DETAIL_CHARS)
      : 'Unknown preparation error.';
    return { outcome: 'failed', result: { success: false, error: `${verb} could not be prepared: ${detail}` } };
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
