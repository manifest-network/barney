import { describe, expect, it, vi } from 'vitest';
import { restartApp, updateApp, type FredAuthCtx } from '@manifest-network/manifest-sdk/deploy';
import { settledMaintenanceRefusal } from './maintenanceRefusal';
import type { MaintenanceOperation } from './maintenanceOperation';

const original: MaintenanceOperation = {
  address: 'manifest1tenant', providerUrl: 'https://provider.example', chainId: 'manifest-dev',
  leaseUuid: '550e8400-e29b-41d4-a716-446655440000', operation: 'restart',
  idempotencyKey: '11111111-1111-4111-8111-111111111111', payloadHash: 'a'.repeat(64), baselineReleaseVersions: [1],
};

async function requestError(command: MaintenanceOperation, status: number, body: string, loseFirstResponse = false) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(body, { status }));
  if (loseFirstResponse) fetch.mockRejectedValueOnce(new TypeError('Response lost after durable receipt was saved'));
  const providerToken = vi.fn(async () => 'fresh-auth');
  const ctx = { fetch, providerAuth: { providerToken } } as unknown as FredAuthCtx;
  const opts = { providerUrl: command.providerUrl, idempotencyKey: command.idempotencyKey, fredCompatibility: 'pr240' as const, pollOptions: false as const };
  const invoke = () => command.operation === 'restart'
    ? restartApp(ctx, { address: command.address, leaseUuid: command.leaseUuid }, opts)
    : updateApp(ctx, { address: command.address, leaseUuid: command.leaseUuid, manifest: '{"image":"nginx"}' }, opts);
  if (loseFirstResponse) {
    const lost = await invoke().catch((error: unknown) => error);
    expect(settledMaintenanceRefusal(lost, command)).toBeUndefined();
  }
  return { error: await invoke().catch((error: unknown) => error), fetch, providerToken };
}

const receipt = (status: number, message: string) => JSON.stringify({ error: message, code: status });

describe('persisted Fred maintenance refusal receipts', () => {
  it.each(['restart', 'update'] as const)('recognizes only exact durable %s receipts through real SDK errors', async (operation) => {
    const command = { ...original, operation };
    for (const [status, message] of [[404, 'lease not yet provisioned'], [409, `invalid state for ${operation}`]] as const) {
      const { error } = await requestError(command, status, receipt(status, message));
      expect(error).toMatchObject({ code: 'MAINTENANCE_REQUEST_FAILED', details: { idempotency_key: command.idempotencyKey, outcome: 'unknown' } });
      expect(settledMaintenanceRefusal(error, command)).toBe(message);
    }
  });

  it('recognizes a saved refusal replay after an earlier same-key response was lost', async () => {
    const { error, fetch, providerToken } = await requestError(original, 409, receipt(409, 'invalid state for restart'), true);
    expect(settledMaintenanceRefusal(error, original)).toBe('invalid state for restart');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(providerToken).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(original.idempotencyKey);
  });

  it.each([
    [400, 'the restart request was rejected as invalid'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'route not found'],
    [409, 'lease is already undergoing a lifecycle operation'],
    [409, 'Idempotency-Key conflicts with a prior maintenance command'],
    [409, 'lease is no longer active'],
    [409, 'invalid state for update'],
    [503, 'service unavailable'],
  ])('retains uncertainty for HTTP %s: %s', async (status, message) => {
    const { error } = await requestError(original, status, receipt(status, message));
    expect(settledMaintenanceRefusal(error, original)).toBeUndefined();
  });

  it.each([
    'invalid state for restart',
    '<html>invalid state for restart</html>',
    '{"error":"invalid state for restart"',
    '{"error":"invalid state for restart","code":400}',
    '{"error":"invalid state for restart","code":409,"reason":"different-contract"}',
  ])('does not infer a receipt from an ambiguous body %s', async (body) => {
    const { error } = await requestError(original, 409, body);
    expect(settledMaintenanceRefusal(error, original)).toBeUndefined();
  });

  it('requires the SDK recovery context to match the retained command', async () => {
    const { error } = await requestError(original, 404, receipt(404, 'lease not yet provisioned'));
    expect(settledMaintenanceRefusal(error, { ...original, idempotencyKey: crypto.randomUUID() })).toBeUndefined();
    expect(settledMaintenanceRefusal(error, { ...original, operation: 'update' })).toBeUndefined();
    expect(settledMaintenanceRefusal(error, { ...original, leaseUuid: crypto.randomUUID() })).toBeUndefined();
    const acceptedReadFailure = { ...(error as object), details: { ...(error as { details: object }).details, outcome: 'accepted' }, cause: error };
    expect(settledMaintenanceRefusal(acceptedReadFailure, original)).toBeUndefined();
  });
});
