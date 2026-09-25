import type { AppEntry } from '../../registry/appRegistry';

/** A maintenance result owns its manifest, while runtime reads can go stale
 * independently. Keep endpoint fields together so URL and inventory agree. */
export function maintenanceRegistryPatch(
  snapshot: AppEntry | null | undefined,
  current: AppEntry | null | undefined,
  patch: Partial<AppEntry>,
): Partial<AppEntry> {
  if (!snapshot || !current || snapshot.providerUrl !== current.providerUrl
    || snapshot.providerUuid !== current.providerUuid) return {};
  const next: Partial<AppEntry> = {};
  if (Object.hasOwn(patch, 'manifest')) next.manifest = patch.manifest;
  // Chain observations can change independently while this command still owns
  // its manifest. Avoid projecting old runtime reads over that newer state.
  if (snapshot.chainState !== current.chainState) return next;
  if (snapshot.provisionState === current.provisionState) {
    if (Object.hasOwn(patch, 'provisionState')) next.provisionState = patch.provisionState;
  }
  // Asking for another runtime observation is conservative even if an earlier
  // read cleared the flag before this command transitioned. Clearing it still
  // requires an unchanged flag so an old verdict cannot cancel a newer check.
  if (patch.readinessStale === true || (snapshot.readinessStale ?? false) === (current.readinessStale ?? false)) {
    if (Object.hasOwn(patch, 'readinessStale') && (patch.readinessStale !== false || current.readinessStale)) {
      next.readinessStale = patch.readinessStale;
    }
  }
  const endpointFields = ['url', 'connection', 'connectionStale'] as const;
  if (endpointFields.every((field) => field === 'connectionStale'
    ? (snapshot[field] ?? false) === (current[field] ?? false)
    : JSON.stringify(snapshot[field]) === JSON.stringify(current[field]))) {
    for (const field of endpointFields) {
      if (Object.hasOwn(patch, field)) Object.assign(next, { [field]: patch[field] });
    }
  }
  return next;
}
