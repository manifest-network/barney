import { describe, expect, it } from 'vitest';
import type { AppEntry } from '../../registry/appRegistry';
import { maintenanceRegistryPatch } from './maintenanceRegistryPatch';

const app: AppEntry = {
  name: 'web', leaseUuid: 'lease-uuid', providerUuid: 'provider', providerUrl: 'https://provider.example',
  createdAt: 1, size: 'small', status: 'running', chainState: 'active', provisionState: 'confirmed',
};

describe('maintenance readiness projection freshness', () => {
  it.each([[undefined, false], [false, undefined]] as const)('keeps a verified failure across an equivalent stale flag %s to %s', (before, after) => {
    const result = maintenanceRegistryPatch(
      { ...app, readinessStale: before }, { ...app, readinessStale: after },
      { provisionState: 'failed', readinessStale: false },
    );
    expect(result).toEqual({ provisionState: 'failed' });
  });

  it('clears a pending readiness recheck only after a definitive current observation', () => {
    expect(maintenanceRegistryPatch(
      { ...app, readinessStale: true }, { ...app, readinessStale: true },
      { provisionState: 'failed', readinessStale: false },
    )).toEqual({ provisionState: 'failed', readinessStale: false });
  });

  it.each([[undefined, true], [true, false]] as const)('does not project old readiness across a real stale flag change %s to %s', (before, after) => {
    expect(maintenanceRegistryPatch(
      { ...app, readinessStale: before }, { ...app, readinessStale: after },
      { provisionState: 'failed', readinessStale: false, manifest: '{"image":"nginx:new"}' },
    )).toEqual({ manifest: '{"image":"nginx:new"}' });
  });

  it('does not replace a newer runtime verdict even when stale flags are equivalent', () => {
    expect(maintenanceRegistryPatch(
      app, { ...app, provisionState: 'failed', readinessStale: false },
      { provisionState: 'confirmed', readinessStale: false },
    )).toEqual({});
  });

  it('keeps verified connection updates across equivalent unset and false connection freshness', () => {
    const snapshot = { ...app, url: 'https://old.example', connection: { host: 'old.example' } };
    const patch = { url: 'https://new.example', connection: { host: 'new.example' }, connectionStale: false };
    expect(maintenanceRegistryPatch(snapshot, { ...snapshot, connectionStale: false }, patch)).toEqual(patch);
    expect(maintenanceRegistryPatch({ ...snapshot, connectionStale: true }, { ...snapshot, connectionStale: false }, patch)).toEqual({});
  });
});
