import {
  describeFredFailure,
  type FredLeaseProvision,
  type FredLeaseReleases,
} from '@manifest-network/manifest-sdk/deploy';
import { failureText } from './helpers';

export interface MaintenanceOutcome {
  readonly outcome: 'succeeded' | 'failed' | 'unconfirmed';
  /** Runtime health is independent of whether the requested replacement succeeded. */
  readonly runtimeReady: boolean;
  readonly detail?: string;
}

function validVersions(versions: readonly number[]): boolean {
  return versions.every((version) => Number.isSafeInteger(version) && version >= 0)
    && new Set(versions).size === versions.length;
}

/** Capture once before the first POST; exact retries must retain this snapshot. */
export function captureMaintenanceBaseline(releases: FredLeaseReleases): readonly number[] | undefined {
  const versions = releases.releases.map((release) => release.version);
  // A pending predecessor makes later history ambiguous even if its work settles
  // before our POST is admitted. Missing historical rows from retention are fine.
  if (!validVersions(versions) || releases.releases.some((release) => release.status === 'deploying')) {
    return undefined;
  }
  return Object.freeze(versions.toSorted((left, right) => left - right));
}

/**
 * Fred's 202 acknowledges admission, including replay of a pending command.
 * A still-healthy source therefore cannot establish replacement success. Check
 * the new release separately; compensated failures leave that release failed
 * while /provision can already be ready again.
 *
 * The tenant API does not expose command keys in release history. Require one
 * consecutive new release and retain uncertainty when multiple operations or a
 * missing history row make attribution ambiguous. Call only after our command
 * has been acknowledged; an uncertain POST alone cannot attribute any release.
 */
export function evaluateMaintenanceOutcome(input: {
  readonly baselineVersions?: readonly number[];
  readonly provision?: FredLeaseProvision;
  readonly releases?: FredLeaseReleases;
}): MaintenanceOutcome {
  const { baselineVersions, provision, releases } = input;
  const runtimeReady = provision?.status === 'ready';
  const unconfirmed = (detail: string): MaintenanceOutcome => ({ outcome: 'unconfirmed', runtimeReady, detail });

  if (baselineVersions === undefined || !validVersions(baselineVersions) || !releases) {
    return unconfirmed('The command outcome could not be verified against its original release history.');
  }
  const currentVersions = releases.releases.map((release) => release.version);
  if (!validVersions(currentVersions)) {
    return unconfirmed('The provider returned ambiguous release history.');
  }
  const baseline = new Set(baselineVersions);
  const added = releases.releases.filter((release) => !baseline.has(release.version));
  if (added.length === 0) {
    return unconfirmed('No new release is visible yet; the provider may still have a pending command.');
  }
  const previousVersion = baselineVersions.length > 0 ? Math.max(...baselineVersions) : 0;
  if (added.length !== 1 || added[0].version !== previousVersion + 1) {
    return unconfirmed('Multiple or missing release generations prevent identifying this command’s outcome.');
  }

  const release = added[0];
  if (release.status === 'failed') {
    return {
      outcome: 'failed',
      runtimeReady,
      detail: failureText(release, 'The requested replacement failed.'),
    };
  }
  if (release.status !== 'active') {
    return unconfirmed('The requested release has not been confirmed active or failed.');
  }
  if (releases.releases.filter((item) => item.status === 'active').length !== 1) {
    return unconfirmed('The provider has not established one active release.');
  }
  if (!runtimeReady || describeFredFailure(release) || (provision && describeFredFailure(provision))) {
    return unconfirmed('The release and runtime observations do not yet confirm a successful command.');
  }
  return { outcome: 'succeeded', runtimeReady };
}
