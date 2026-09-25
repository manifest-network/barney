import { asLeaseUuid } from '@manifest-network/manifest-sdk';
import type { FredLeaseReleases } from '@manifest-network/manifest-sdk/deploy';
import { getLeaseProvision, getLeaseReleases } from '../../api/fred';
import { sanitizeManifestForStorage } from '../../registry/appRegistry';
import { runtimeConfig } from '../../config/runtimeConfig';
import { finishDisplaySentence } from '../../utils/displaySentence';
import { maintenanceReadinessPatch } from './maintenanceReadiness';
import { maintenanceRegistryPatch } from './maintenanceRegistryPatch';
import { recoverReleaseManifest } from './maintenancePayload';
import { captureMaintenanceCompletionEpoch, isMaintenanceCompletionEpochCurrent, rememberMaintenanceCompletion } from './maintenanceCompletion';
import { resolveAppEndpoint } from './helpers';
import { getPendingMaintenanceOperation, commitMaintenanceObservation, markMaintenanceRecoveryAdvised, MaintenanceSettlementStorageError } from './maintenanceOperation';
import { evaluateMaintenanceOutcome, type MaintenanceOutcome } from './maintenanceOutcome';
import type { AppEntry } from '../../registry/appRegistry';
import type { ToolExecutorOptions } from './types';

export interface MaintenanceReconciliation extends Omit<MaintenanceOutcome, 'runtimeReady'> {
  /** Omitted when this read did not observe runtime readiness. */
  readonly runtimeReady?: boolean;
  readonly operation?: 'restart' | 'update';
}

/** Observe a retained command without needing its raw update payload or issuing a POST. */
export async function reconcilePendingMaintenance(
  app: AppEntry,
  options: ToolExecutorOptions,
  observedReleases?: FredLeaseReleases,
  observedProvisionStatus?: string,
): Promise<MaintenanceReconciliation | undefined> {
  const { address, signing, appRegistry, signal } = options;
  signal?.throwIfAborted();
  if (!address || !app.providerUrl || !appRegistry) return undefined;
  const observedReadiness = observedProvisionStatus === undefined || observedProvisionStatus === ''
    ? {} : { runtimeReady: observedProvisionStatus === 'ready' };
  let command;
  try {
    command = getPendingMaintenanceOperation(address, app.providerUrl, app.leaseUuid,
      options.authorization?.chainId ?? runtimeConfig.PUBLIC_CHAIN_ID);
  } catch (error) {
    return { outcome: 'unconfirmed', ...observedReadiness, detail: error instanceof Error ? error.message : 'The saved maintenance operation could not be read.' };
  }
  if (!command) return undefined;
  // Without acknowledged admission, release history cannot attribute a result
  // to this key. Do not prompt for redundant wallet signatures or fetch history
  // on every status read; explicit recovery owns the exact-key retry.
  if (!command.accepted || !signing) {
    await markMaintenanceRecoveryAdvised(command, options.onMaintenanceRecoveryAdvice);
    return { operation: command.operation, outcome: 'unconfirmed', ...observedReadiness,
      detail: !command.accepted
        ? 'Provider admission of this command has not been confirmed. Recover the original command with its same key and exact payload; release history alone cannot identify it.'
        : 'Connect the wallet to read the pending command outcome.' };
  }

  const completionEpoch = captureMaintenanceCompletionEpoch(command);
  const currentApp = appRegistry.getAppByLease(address, app.leaseUuid);
  const registrySnapshot = structuredClone(currentApp);
  const token = async () => {
    signal?.throwIfAborted();
    const auth = await signing.authTokens.getAuthToken(asLeaseUuid(app.leaseUuid));
    signal?.throwIfAborted();
    return auth;
  };
  const [provisionRead, releasesRead] = await Promise.allSettled([
    token().then((auth) => getLeaseProvision(app.providerUrl, app.leaseUuid, auth)),
    observedReleases ? Promise.resolve(observedReleases) : token().then((auth) => getLeaseReleases(app.providerUrl, app.leaseUuid, auth)),
  ]);
  signal?.throwIfAborted();
  const provision = provisionRead.status === 'fulfilled' ? provisionRead.value : undefined;
  const releases = releasesRead.status === 'fulfilled' ? releasesRead.value : undefined;
  const verdict: MaintenanceOutcome = evaluateMaintenanceOutcome({ baselineVersions: command.baselineReleaseVersions, provision, releases });
  const patch = maintenanceReadinessPatch(provision?.status, registrySnapshot);
  if (command.operation === 'update' && verdict.outcome === 'succeeded') {
    // A reload deliberately discards secret manifest bytes. Use the identified
    // active release's manifest when available; otherwise remove stale cache
    // contents so the pre-update image is never presented as current.
    const target = releases?.releases.find((release) => !command.baselineReleaseVersions.includes(release.version));
    const manifest = command.manifest ?? await recoverReleaseManifest(target?.manifest, command.payloadHash);
    patch.manifest = manifest === undefined ? undefined : sanitizeManifestForStorage(manifest);
  }
  // No registry mutation may precede an awaited read/hash or queued scope lock:
  // a newer command may have completed while this observation was in flight.
  if (verdict.outcome === 'unconfirmed') await markMaintenanceRecoveryAdvised(command, options.onMaintenanceRecoveryAdvice);
  let cleanupDetail: string | undefined;
  const committed = await commitMaintenanceObservation(command, {
    settled: verdict.outcome !== 'unconfirmed',
    ...(verdict.outcome !== 'unconfirmed' && { outcome: verdict.outcome }),
    isCurrent: () => {
      signal?.throwIfAborted();
      const current = appRegistry.getAppByLease(address, app.leaseUuid);
      return isMaintenanceCompletionEpochCurrent(completionEpoch)
        && current?.providerUrl === registrySnapshot?.providerUrl
        && current?.providerUuid === registrySnapshot?.providerUuid
        && current?.chainState === registrySnapshot?.chainState;
    },
    apply: () => {
      const currentPatch = maintenanceRegistryPatch(registrySnapshot, appRegistry.getAppByLease(address, app.leaseUuid), patch);
      if (Object.keys(currentPatch).length > 0) appRegistry.updateApp(address, app.leaseUuid, currentPatch);
      if (verdict.outcome === 'unconfirmed') return;
      // Failed updates never replace the registry manifest, including after reload.
      const current = appRegistry.getAppByLease(address, app.leaseUuid) ?? app;
      const url = verdict.runtimeReady ? resolveAppEndpoint(current) : undefined;
      const verb = command.operation === 'restart' ? 'Restart' : 'Update';
      rememberMaintenanceCompletion(command, verdict.outcome === 'succeeded'
        ? { outcome: 'succeeded', url, result: { success: true, data: {
          message: `App "${app.name}" has been ${command.operation === 'restart' ? 'restarted' : 'updated'}.`,
          name: app.name, url, status: 'running',
        } } }
        : { outcome: 'failed', result: { success: false,
          error: finishDisplaySentence(`${verb} failed${verdict.runtimeReady ? '; the previous runtime is healthy' : ''}. ${verdict.detail ?? ''}`),
        } }, completionEpoch);
    },
  }).catch((error: unknown) => {
    if (!(error instanceof MaintenanceSettlementStorageError)) throw error;
    cleanupDetail = error.message;
    return true;
  });
  if (cleanupDetail) await markMaintenanceRecoveryAdvised(command, options.onMaintenanceRecoveryAdvice);
  if (!committed) {
    await markMaintenanceRecoveryAdvised(command, options.onMaintenanceRecoveryAdvice);
    return { operation: command.operation, outcome: 'unconfirmed',
      detail: 'The app or saved command changed during reconciliation. Read app_status and app_releases again.' };
  }
  const { runtimeReady, ...outcome } = verdict;
  return { operation: command.operation, ...outcome, ...(provision ? { runtimeReady } : observedReadiness),
    ...(cleanupDetail && { detail: [outcome.detail ? finishDisplaySentence(outcome.detail) : '', cleanupDetail].filter(Boolean).join(' ') }) };
}
