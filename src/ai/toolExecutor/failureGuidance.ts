/**
 * Barney-shaped next-step guidance for fred failure reasons.
 *
 * The SDK's `FRED_REASON_GUIDANCE` is curated for mono's OWN MCP tool surface,
 * and three of its `nextStep` sentences name a call barney cannot serve:
 * `ContainerExited` / `Unknown` say `get_logs({ lease_uuid, tail: 200 })` —
 * barney's `get_logs` takes `app_name` — and `RestoreFailed` names a
 * `restore_app` tool barney does not have. Those three are replaced (keeping the
 * SDK's tool-free `explanation` as the lead); the rest name only tools barney
 * does have and are relayed VERBATIM, so the taxonomy cannot drift from the SDK's.
 *
 * OPEN-SET CONTRACT. Fred's `reason` set is open and add-only.
 * `isKnownFailureReason` is the ONLY gate here: an unrecognized reason yields
 * `undefined` (no next step at all), never a throw, never a substitution, and
 * never a reason to drop `reason` itself. Nothing in this module may switch
 * exhaustively over fred's set.
 */

import {
  FRED_REASON_GUIDANCE,
  isKnownFailureReason,
} from '@manifest-network/manifest-sdk/deploy';

/** The reasons this SDK build curates. Derived, never hand-listed. */
type CuratedFailureReason = keyof typeof FRED_REASON_GUIDANCE;

/** Builds barney's replacement sentence for one reason, given the app name. */
type NextStepBuilder = (appName: string) => string;

/**
 * Reasons whose SDK `nextStep` names a tool barney lacks or a call shape it
 * rejects. Anything absent keeps the SDK sentence unchanged.
 *
 * `Partial<Record<CuratedFailureReason, …>>` is deliberate on both halves: a key
 * added here must be a reason the SDK actually curates (a typo fails the build),
 * while a reason fred adds LATER needs no row — it simply has no curated guidance.
 */
const BARNEY_NEXT_STEP: Partial<Record<CuratedFailureReason, NextStepBuilder>> = {
  ContainerExited: (name) =>
    `${FRED_REASON_GUIDANCE.ContainerExited.explanation} ` +
    `Call get_logs("${name}", 200) and read the lines just before the exit. ` +
    `Fix the entrypoint or config and update_app("${name}"); if it was OOM-killed, ` +
    `redeploy on a larger size instead.`,

  Unknown: (name) =>
    `${FRED_REASON_GUIDANCE.Unknown.explanation} ` +
    `Call get_logs("${name}", 200) — container output is the only remaining signal. ` +
    `If it is empty, the failure happened before the container started.`,

  // No restore path exists here, so the SDK's "retry restore_app" is
  // unfollowable. Say so plainly rather than inventing a substitute action.
  RestoreFailed: (name) =>
    `${FRED_REASON_GUIDANCE.RestoreFailed.explanation} ` +
    `There is no restore tool here, so the restore cannot be retried from this app. ` +
    `Check app_status("${name}") for the current state, and report the lease UUID to the ` +
    `provider operator if the retained data still matters — the retention window is finite.`,
};

/**
 * The next step to show for a fred failure `reason`, in barney's tool surface.
 *
 * Returns `undefined` when this SDK build curates no guidance for the reason —
 * the NORMAL case for a value from a newer fred. Callers must treat that as
 * "omit the next step", never as "reject the reason".
 *
 * Single source of truth for all three next-step sinks: `app_diagnostics`
 * (compositeQueries.ts), `deployError.ts`, and `compositeTransactions.ts`.
 */
export function nextStepFor(reason: string | undefined, appName: string): string | undefined {
  if (reason === undefined || !isKnownFailureReason(reason)) return undefined;
  const override = BARNEY_NEXT_STEP[reason];
  return override ? override(appName) : FRED_REASON_GUIDANCE[reason].nextStep;
}
