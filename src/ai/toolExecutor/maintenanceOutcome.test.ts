import { describe, expect, it } from 'vitest';
import type { FredLeaseProvision, FredLeaseRelease, FredLeaseReleases } from '@manifest-network/manifest-sdk/deploy';
import { captureMaintenanceBaseline, evaluateMaintenanceOutcome } from './maintenanceOutcome';

const provision = (overrides: Partial<FredLeaseProvision> = {}): FredLeaseProvision => ({
  status: 'ready', fail_count: 0, ...overrides,
});
const release = (version: number, status = 'active', overrides: Partial<FredLeaseRelease> = {}): FredLeaseRelease => ({
  version, status, image: 'stack', created_at: '2026-09-22T12:00:00Z', ...overrides,
});
const history = (...releases: FredLeaseRelease[]): FredLeaseReleases => ({
  lease_uuid: 'lease-1', tenant: 'tenant-1', provider_uuid: 'provider-1', releases,
});

describe('maintenance outcome verification', () => {
  it('snapshots versions before dispatch without retaining mutable response data', () => {
    const response = history(release(3), release(1, 'superseded'), release(2, 'failed'));
    const baseline = captureMaintenanceBaseline(response);
    expect(baseline).toEqual([1, 2, 3]);
    expect(Object.isFrozen(baseline)).toBe(true);
    expect(response.releases.map((item) => item.version)).toEqual([3, 1, 2]);
  });

  it('does not capture an ambiguous baseline with another command still deploying', () => {
    expect(() => captureMaintenanceBaseline(history(release(1), release(2, 'deploying'))))
      .toThrow('Another command is in progress (release v2 is deploying). Wait and check app_releases and app_status');
    expect(() => captureMaintenanceBaseline(history(release(1), release(1)))).toThrow('ambiguous release history');
    expect(() => captureMaintenanceBaseline(history(release(Number.NaN)))).toThrow('ambiguous release history');
  });

  it('accepts an empty history and verifies the first release when it becomes active', () => {
    const baselineVersions = captureMaintenanceBaseline(history());
    expect(baselineVersions).toEqual([]);
    expect(evaluateMaintenanceOutcome({ baselineVersions, provision: provision(), releases: history(release(1)) }))
      .toEqual({ outcome: 'succeeded', runtimeReady: true });
  });

  it('confirms a new active release after readiness even when retained old rows disappear', () => {
    expect(evaluateMaintenanceOutcome({
      baselineVersions: [1, 2], provision: provision(), releases: history(release(3)),
    })).toEqual({ outcome: 'succeeded', runtimeReady: true });
  });

  it('keeps a replay pending when the original source is healthy and no new release exists', () => {
    expect(evaluateMaintenanceOutcome({
      baselineVersions: [1], provision: provision(), releases: history(release(1)),
    })).toMatchObject({ outcome: 'unconfirmed', runtimeReady: true });
  });

  it.each(['deploying', 'superseded', 'future-status'])('does not mistake a %s release for success', (status) => {
    expect(evaluateMaintenanceOutcome({
      baselineVersions: [1], provision: provision(), releases: history(release(1), release(2, status)),
    })).toMatchObject({ outcome: 'unconfirmed', runtimeReady: true });
  });

  it.each(['RestartFailed', 'ImagePullFailed', 'UpdateFailed', 'FutureFailure'])('retains a compensated %s outcome despite healthy runtime', (reason) => {
    expect(evaluateMaintenanceOutcome({
      baselineVersions: [1],
      provision: provision({ reason, message: 'Target failed; source recovered.' }),
      releases: history(release(1), release(2, 'failed', { reason, message: 'Replacement failed.' })),
    })).toEqual({ outcome: 'failed', runtimeReady: true, detail: `${reason}: Replacement failed.` });
  });

  it('reports the failed command separately when compensation also failed', () => {
    expect(evaluateMaintenanceOutcome({
      baselineVersions: [1], provision: provision({ status: 'failed' }),
      releases: history(release(1), release(2, 'failed')),
    })).toMatchObject({ outcome: 'failed', runtimeReady: false });
  });

  it('retains definite release failure when the runtime read is unavailable', () => {
    expect(evaluateMaintenanceOutcome({
      baselineVersions: [1], releases: history(release(1), release(2, 'failed')),
    })).toMatchObject({ outcome: 'failed', runtimeReady: false });
  });

  it.each([
    undefined,
    provision({ status: 'updating' }),
    provision({ status: 'unknown' }),
    provision({ status: 'failing', reason: 'ContainerExited' }),
    provision({ reason: 'RestartFailed' }),
  ])('does not infer runtime success from an active release alone', (observed) => {
    expect(evaluateMaintenanceOutcome({
      baselineVersions: [1], provision: observed, releases: history(release(1, 'superseded'), release(2)),
    }).outcome).toBe('unconfirmed');
  });

  it('does not attribute a later unrelated command or missing generation to this command', () => {
    for (const releases of [
      history(release(2, 'failed'), release(3)),
      history(release(3)),
      history(release(1), release(2), release(2)),
    ]) {
      expect(evaluateMaintenanceOutcome({ baselineVersions: [1], provision: provision(), releases }).outcome)
        .toBe('unconfirmed');
    }
  });

  it('does not accept contradictory history reporting both source and target active', () => {
    expect(evaluateMaintenanceOutcome({
      baselineVersions: [1], provision: provision(), releases: history(release(1), release(2)),
    })).toMatchObject({ outcome: 'unconfirmed', runtimeReady: true });
  });

  it('retains uncertainty when the original baseline or verification reads are missing', () => {
    expect(evaluateMaintenanceOutcome({ provision: provision(), releases: history(release(2)) }).outcome).toBe('unconfirmed');
    expect(evaluateMaintenanceOutcome({ baselineVersions: [1], provision: provision() }).outcome).toBe('unconfirmed');
  });
});
