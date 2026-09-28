import { ProviderApiError } from '@manifest-network/manifest-sdk/deploy';
import type { MaintenanceOperation } from './maintenanceOperation';

/**
 * Fred f42a639 persists maintenance validation refusals and these exact 404/409
 * receipts. Its route has five distinct pre-admission 400 messages; those do
 * not establish settlement. Keep this classifier tied to that Fred contract
 * until the tenant API exposes structured receipt codes.
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
      || ![400, 404, 409].includes(details.provider_status as number)) return undefined;

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
            if (receipt.code !== cause.status || typeof receipt.error !== 'string'
              || !Object.keys(receipt).every((key) => key === 'code' || key === 'error')) return undefined;
            if (cause.status === 400) {
              // These are the complete pre-service 400 branches in the target
              // Fred maintenance handlers/authentication path. Other curated
              // details originate from a persisted ValidationRejected receipt.
              const preAdmissionErrors = new Set([
                'invalid lease UUID format',
                'Idempotency-Key header must occur exactly once',
                'Idempotency-Key must be a canonical UUIDv4',
                'invalid request body',
                'payload is required',
              ]);
              const detail = receipt.error;
              if (detail.trim() && new TextEncoder().encode(detail).length <= 515
                && [...detail].every((character) => {
                  const code = character.codePointAt(0)!;
                  return code > 31 && (code < 127 || code > 159);
                })
                && !preAdmissionErrors.has(detail)) return detail;
            } else if (receipt.error === expected) return expected;
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
