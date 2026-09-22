import { ProviderApiError } from '@manifest-network/manifest-sdk/deploy';
import type { MaintenanceOperation } from './maintenanceOperation';

/**
 * Fred f42a639 persists these two exact receipts before returning/replaying them.
 * Status alone is insufficient: other 409s retain an earlier pending command,
 * and 400 combines pre-dispatch parsing errors with durable validation refusals.
 * Keep this allowlist tied to the pr240 contract until Fred exposes receipt codes.
 */
export function settledMaintenanceRefusal(error: unknown, command: MaintenanceOperation): string | undefined {
  try {
    if (typeof error !== 'object' || error === null) return undefined;
    const outer = error as { code?: unknown; details?: Record<string, unknown> };
    const details = outer.details;
    if (outer.code !== 'MAINTENANCE_REQUEST_FAILED'
      || details?.lease_uuid !== command.leaseUuid
      || details.idempotency_key !== command.idempotencyKey
      || details.operation !== command.operation
      || details.outcome !== 'unknown'
      || (details.provider_status !== 404 && details.provider_status !== 409)) return undefined;

    const expected = details.provider_status === 404
      ? 'lease not yet provisioned'
      : `invalid state for ${command.operation}`;
    const seen = new Set<object>();
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && typeof cause === 'object' && cause !== null && !seen.has(cause); depth += 1) {
      seen.add(cause);
      if (ProviderApiError.isProviderApiError(cause)
        && cause.status === details.provider_status && cause.kind === 'http') {
        // The SDK keeps the raw bounded HTTP error body on its ProviderApiError
        // cause. Never substring-match composed SDK diagnostics or HTML bodies.
        try {
          const body: unknown = JSON.parse(cause.message);
          if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
            const receipt = body as Record<string, unknown>;
            if (receipt.code === cause.status && receipt.error === expected
              && Object.keys(receipt).every((key) => key === 'code' || key === 'error')) return expected;
          }
        } catch {
          // Malformed/truncated error bodies cannot establish a durable receipt.
        }
      }
      cause = (cause as { cause?: unknown }).cause;
    }
  } catch {
    // A malformed diagnostic must never release recovery metadata.
  }
  return undefined;
}
