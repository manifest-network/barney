/**
 * ONE reading of fred's `provision_status`, shared by the query and the
 * transaction executors.
 *
 * It lives in its own module because the two files had grown a hand-maintained
 * status set each and had already drifted apart on `failing` — the same
 * contract-drift class this compat work exists to close.
 */

import {
  PROVISION_SUCCESS,
  PROVISION_FAILED,
  PROVISION_IN_PROGRESS,
} from '@manifest-network/manifest-sdk/deploy';
import type { ProvisionState } from '../../registry/appRegistry';

/** fred's soft-delete: the workload is torn down and only its volumes are kept
 *  (restore needs a fresh lease). The SDK models it, but does not export the set. */
const PROVISION_RETAINED = 'retained';

/**
 * `failing` is a VERDICT about the workload, not progress towards one. fred
 * enters Failing ONLY from Ready, on `evContainerDied`, and `onEnterFailing`
 * writes `Reason: ContainerExited` synchronously before the async diagnostics
 * gather flips it to `failed` (fred `internal/backend/shared/leasesm/lease_sm.go`).
 *
 * The SDK lists it under `PROVISION_IN_PROGRESS` for its own reason: a readiness
 * POLL must keep waiting for the settle to `failed` rather than resolving. That
 * is a poll rule, not a classification, so it is corrected here — in one place,
 * for both consumers.
 */
const PROVISION_VERDICT_FAILED: ReadonlySet<string> = new Set([...PROVISION_FAILED, 'failing']);

/**
 * True when the status carries NO verdict about the workload — the only reason
 * a caller may ignore what fred reported alongside it.
 *
 * Derived from the SDK set MINUS the failure verdicts rather than hand-listed,
 * so a status a newer fred adds to `PROVISION_IN_PROGRESS` reaches both
 * consumers at once. A value in none of the SDK's sets is deliberately NOT
 * unsettled: fred's vocabulary is open and add-only, so the default for an
 * unmodelled value is "trust the verdict", not "stay silent". An ABSENT status
 * IS unsettled — `omitempty` drops the field when a degraded provider's
 * best-effort provision lookup fails.
 */
export function isUnsettledProvisionStatus(status: string | undefined): boolean {
  if (status === undefined || status === '') return true;
  return PROVISION_IN_PROGRESS.has(status) && !PROVISION_VERDICT_FAILED.has(status);
}

/**
 * Map fred's `provision_status` onto the registry's `provisionState`
 * OBSERVATION.
 *
 * An unsettled value IS a reading — fred is saying the workload is not up — so
 * it records 'unconfirmed' rather than nothing; the caller keeps it from
 * retracting an earlier confirmation. Any value in none of the sets is a future
 * one this client does not model and claims nothing, as does an ABSENT field.
 */
export function classifyProvisionStatus(status: string | undefined): ProvisionState | undefined {
  if (status === undefined || status === '') return undefined;
  if (PROVISION_SUCCESS.has(status)) return 'confirmed';
  if (PROVISION_VERDICT_FAILED.has(status)) return 'failed';
  if (PROVISION_IN_PROGRESS.has(status) || status === PROVISION_RETAINED) return 'unconfirmed';
  return undefined;
}
