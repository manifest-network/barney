/**
 * Barney's fred-failure next-step remapper.
 *
 * The sink tests (compositeQueries.test.ts / deployError.test.ts) cover the two
 * places the sentences reach chat; this file covers the mapping itself across
 * fred's WHOLE curated set, so a future SDK bump that rewords a `nextStep` into
 * a tool barney lacks fails here rather than silently shipping.
 */

import { describe, it, expect } from 'vitest';
import { FRED_FAILURE_REASONS, FRED_REASON_GUIDANCE } from '@manifest-network/manifest-sdk/deploy';
import { nextStepFor } from './failureGuidance';

/** Tool names that appear in the SDK's prose but do not exist in barney. */
const TOOLS_BARNEY_LACKS = ['restore_app', 'close_lease', 'wait_for_app_ready'];

/** The reasons whose SDK sentence is unfollowable in barney and must be replaced. */
const REMAPPED = ['ContainerExited', 'Unknown', 'RestoreFailed'] as const;

describe('nextStepFor — barney tool-surface compatibility', () => {
  it.each(FRED_FAILURE_REASONS)('emits a barney-followable next step for %s', (reason) => {
    const step = nextStepFor(reason, 'my-app');
    expect(step).toBeDefined();
    // `get_logs({ lease_uuid, tail: 200 })` is mono's call shape; barney's
    // get_logs takes `app_name`, so the model would send app_name: undefined.
    expect(step).not.toContain('lease_uuid');
    for (const tool of TOOLS_BARNEY_LACKS) expect(step).not.toContain(tool);
  });

  it.each(REMAPPED)('keeps the tool-free explanation when it replaces %s', (reason) => {
    // The taxonomy's value survives the substitution: only the actionable half
    // is barney's own, the diagnosis stays the SDK's.
    expect(nextStepFor(reason, 'my-app')).toContain(FRED_REASON_GUIDANCE[reason].explanation);
    expect(nextStepFor(reason, 'my-app')).not.toBe(FRED_REASON_GUIDANCE[reason].nextStep);
  });

  it('relays every other curated sentence verbatim', () => {
    const untouched = FRED_FAILURE_REASONS.filter(
      (reason) => !(REMAPPED as readonly string[]).includes(reason)
    );
    // Guard against the remap quietly growing into a full local rewrite that
    // would drift from the SDK's curation.
    expect(untouched).toEqual([
      'ImagePullFailed',
      'Internal',
      'RestartFailed',
      'UpdateFailed',
      'VolumeCleanupExhausted',
      'CleanupFailed',
    ]);
    for (const reason of untouched) {
      expect(nextStepFor(reason, 'my-app')).toBe(FRED_REASON_GUIDANCE[reason].nextStep);
    }
  });

  it('interpolates the app name into every replacement', () => {
    for (const reason of REMAPPED) {
      expect(nextStepFor(reason, 'redis-cache')).toContain('"redis-cache"');
    }
  });
});

describe('nextStepFor — open-set contract', () => {
  // fred documents `reason` as open and add-only: consumers MUST tolerate an
  // unrecognized value. `isKnownFailureReason` is the only gate.
  it('returns undefined for a reason from a newer fred, without throwing', () => {
    expect(nextStepFor('SomeFutureReason', 'my-app')).toBeUndefined();
  });

  it('returns undefined for an absent or empty reason', () => {
    expect(nextStepFor(undefined, 'my-app')).toBeUndefined();
    expect(nextStepFor('', 'my-app')).toBeUndefined();
  });

  it('never substitutes guidance for an unknown reason', () => {
    // The failure mode this guards: inferring "looks like a container problem"
    // from an unrecognized string and fabricating a next step for it.
    expect(nextStepFor('ContainerExitedV2', 'my-app')).toBeUndefined();
    expect(nextStepFor('containerexited', 'my-app')).toBeUndefined();
  });
});
