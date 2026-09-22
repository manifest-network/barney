import { asLeaseUuid } from '@manifest-network/manifest-sdk';
import { metaHashHex, type FredLeaseReleases } from '@manifest-network/manifest-sdk/deploy';
import { getLeaseProvision, getLeaseReleases } from '../../api/fred';
import { sanitizeManifestForStorage } from '../../registry/appRegistry';
import { runtimeConfig } from '../../config/runtimeConfig';
import { classifyProvisionStatus } from './provisionStatus';
import { rememberMaintenanceCompletion } from './maintenanceCompletion';
import { resolveAppEndpoint } from './helpers';
import { getPendingMaintenanceOperation, commitMaintenanceObservation } from './maintenanceOperation';
import { evaluateMaintenanceOutcome, type MaintenanceOutcome } from './maintenanceOutcome';
import type { AppEntry } from '../../registry/appRegistry';
import type { ToolExecutorOptions } from './types';

export interface MaintenanceReconciliation extends MaintenanceOutcome {
  readonly operation?: 'restart' | 'update';
}

/** Fred returns historical manifest bytes as base64, not JSON text. */
async function recoverReleaseManifest(encoded: string | undefined, payloadHash: string): Promise<string | undefined> {
  if (!encoded) return undefined;
  try {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (await metaHashHex(decoded) !== payloadHash) return undefined;
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

/** Observe a retained command without needing its raw update payload or issuing a POST. */
export async function reconcilePendingMaintenance(
  app: AppEntry,
  options: ToolExecutorOptions,
  observedReleases?: FredLeaseReleases,
): Promise<MaintenanceReconciliation | undefined> {
  const { address, signing, appRegistry, signal } = options;
  signal?.throwIfAborted();
  if (!address || !app.providerUrl || !appRegistry) return undefined;
  let command;
  try {
    command = getPendingMaintenanceOperation(address, app.providerUrl, app.leaseUuid,
      options.authorization?.chainId ?? runtimeConfig.PUBLIC_CHAIN_ID);
  } catch (error) {
    return { outcome: 'unconfirmed', runtimeReady: false, detail: error instanceof Error ? error.message : 'The saved maintenance operation could not be read.' };
  }
  if (!command) return undefined;
  if (!signing) return { operation: command.operation, outcome: 'unconfirmed', runtimeReady: false, detail: 'Connect the wallet to read the pending command outcome.' };

  const registrySnapshot = JSON.stringify(appRegistry.getAppByLease(address, app.leaseUuid));
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
  // A release has no command key. After a lost POST response, another client's
  // release cannot prove that our saved command was admitted or has completed.
  const verdict: MaintenanceOutcome = command.accepted
    ? evaluateMaintenanceOutcome({ baselineVersions: command.baselineReleaseVersions, provision, releases })
    : { outcome: 'unconfirmed', runtimeReady: provision?.status === 'ready', detail: 'Provider admission of this command has not been confirmed. Recover the original command with its same key and exact payload; release history alone cannot identify it.' };
  const patch: Partial<Omit<AppEntry, 'leaseUuid'>> = {};
  if (provision) {
    const provisionState = classifyProvisionStatus(provision.status);
    if (provisionState) patch.provisionState = provisionState;
  }
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
  const committed = await commitMaintenanceObservation(command, {
    settled: verdict.outcome !== 'unconfirmed',
    isCurrent: () => {
      signal?.throwIfAborted();
      return JSON.stringify(appRegistry.getAppByLease(address, app.leaseUuid)) === registrySnapshot;
    },
    apply: () => {
      if (Object.keys(patch).length > 0) appRegistry.updateApp(address, app.leaseUuid, patch);
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
          error: `${verb} failed${verdict.runtimeReady ? '; the previous runtime is healthy' : ''}. ${verdict.detail ?? ''}`.trim(),
        } });
    },
  });
  if (!committed) return { operation: command.operation, outcome: 'unconfirmed', runtimeReady: false,
    detail: 'The app or saved command changed during reconciliation. Read app_status and app_releases again.' };
  return { operation: command.operation, ...verdict };
}
