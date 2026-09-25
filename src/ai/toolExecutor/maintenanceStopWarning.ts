import { fredCompatibilityForProvider } from '../../config/fredCompatibility';
import type { AppEntry } from '../../registry/appRegistry';
import { sanitizeForDisplay } from '../../utils/sanitizeText';
import { getPendingMaintenanceOperation } from './maintenanceOperation';

/** Shared by model and AppCard stop confirmations; reads local metadata only. */
export function pendingMaintenanceStopWarning(apps: readonly AppEntry[], address: string, chainId?: string): string {
  const pending: string[] = [];
  const unreadable: string[] = [];
  for (const app of apps) {
    if (!app.providerUrl) continue;
    const name = `"${sanitizeForDisplay(app.name)}"`;
    try {
      if (fredCompatibilityForProvider(app.providerUrl) !== 'pr240') continue;
      if (getPendingMaintenanceOperation(address, app.providerUrl, app.leaseUuid, chainId)) pending.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  const warnings: string[] = [];
  if (pending.length) warnings.push(`Fred may execute pending maintenance for ${pending.join(', ')} until ${pending.length === 1 ? 'its lease closes' : 'their leases close'}. Stopping ends ${pending.length === 1 ? 'the deployment' : 'these deployments'}; it does not recover the pending command${pending.length === 1 ? '' : 's'}.`);
  if (unreadable.length) warnings.push(`Saved maintenance could not be checked for ${unreadable.join(', ')}. Fred may still execute pending commands for ${unreadable.length === 1 ? 'this app until its lease closes' : 'these apps until their leases close'}.`);
  return warnings.length ? ` ${warnings.join(' ')}` : '';
}
