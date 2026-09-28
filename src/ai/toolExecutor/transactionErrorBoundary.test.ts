import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toBech32 } from '@cosmjs/encoding';
import { ManifestMCPError, ManifestMCPErrorCode, type CosmosClientManager } from '@manifest-network/manifest-sdk';
import { executeConfirmedTool, executeTool } from './index';
import { makeRegistry } from './testHelpers';
import { FAILURE_DETAIL_CHARS } from './helpers';
import type { ToolExecutorOptions } from './types';

vi.mock('../../utils/errors', async (original) => ({ ...await original<typeof import('../../utils/errors')>(), logError: vi.fn() }));

const address = toBech32('manifest', new Uint8Array(20).fill(1));
const app = {
  name: 'web', leaseUuid: '550e8400-e29b-41d4-a716-446655440000', providerUuid: 'provider-1',
  providerUrl: 'https://provider.example.com', size: 'small', createdAt: 0,
  status: 'running' as const, chainState: 'active' as const, provisionState: 'confirmed' as const,
};
const body = `<html>\nWAF denied\u0000\u202e\u2028\u2029\t${'🦕'.repeat(1_000)}\n</html>`;
const actions = [
  ['stop_app', { app_name: app.name, leaseUuid: app.leaseUuid }],
  ['fund_credits', { amount: 1, address }],
  ['set_custom_domain', { app_name: app.name, leaseUuid: app.leaseUuid, customDomain: '', address }],
] as const;

function fixture() {
  const broadcast = vi.fn().mockResolvedValue({
    code: 7, rawLog: body, transactionHash: 'AB'.repeat(32), height: 42,
    gasUsed: 10n, gasWanted: 20n, events: [],
  });
  const query = vi.fn().mockResolvedValue({ lease: { state: 2 } });
  const chain = {
    getConfig: () => ({ retry: { maxRetries: 0 } }),
    getAddress: vi.fn().mockResolvedValue(address),
    getQueryClient: vi.fn().mockResolvedValue({ liftedinit: { billing: { v1: { lease: query } } } }),
    getBroadcastClient: vi.fn().mockResolvedValue({ signAndBroadcast: broadcast }),
    withBroadcastLock: async (_address: string, work: () => Promise<unknown>) => work(),
    acquireRateLimit: vi.fn().mockResolvedValue(undefined),
  };
  const registry = makeRegistry([app]);
  const options: ToolExecutorOptions = {
    address, clientManager: chain as unknown as CosmosClientManager, tiers: [], appRegistry: registry,
    authorization: { originAddress: address, chainId: 'audit', clientGeneration: 1, signerGeneration: 1 },
    assertAuthorization: vi.fn(),
  };
  return { options, registry, chain, broadcast };
}

function expectBounded(detail: string | undefined) {
  expect(detail).toBeDefined();
  expect(detail).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  expect(detail).not.toMatch(/[\uD800-\uDFFF]/u);
  expect(Array.from(detail!)).toHaveLength(FAILURE_DETAIL_CHARS + 1);
  expect(detail!.endsWith('…')).toBe(true);
}

beforeEach(() => vi.clearAllMocks());

describe('confirmed chain action error boundaries through the real SDK', () => {
  it.each(actions)('bounds confirmed chain rejection diagnostics from %s without retrying', async (tool, args) => {
    const { options, registry, broadcast } = fixture();
    const result = await executeConfirmedTool(tool, args, options);

    expect(result.success).toBe(false);
    expect(result.error).toContain('failed with code 7: <html> WAF denied');
    expectBounded(result.error);
    expect(broadcast).toHaveBeenCalledOnce();
    expect(registry.updateApp).not.toHaveBeenCalled();
    expect(result.error).not.toContain('may still commit');
  });

  it.each(actions)('bounds pre-submission SDK/chain failures from %s', async (tool, args) => {
    const { options, chain, broadcast } = fixture();
    chain.getQueryClient.mockRejectedValue(new Error(body));
    chain.getAddress.mockRejectedValue(new Error(body));

    const result = await executeConfirmedTool(tool, args, options);
    expect(result.success).toBe(false);
    expectBounded(result.error);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(actions)('preserves successful %s results even when successful rawLog is verbose', async (tool, args) => {
    const { options, broadcast } = fixture();
    broadcast.mockResolvedValue({ code: 0, rawLog: body, transactionHash: 'AB'.repeat(32), height: 42, gasUsed: 10n, gasWanted: 20n, events: [] });

    const result = await executeConfirmedTool(tool, args, options);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(broadcast).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.data)).not.toContain('WAF denied');
  });

  it.each([actions[0], actions[2]])('retains complete post-broadcast cancellation guidance for %s', async (tool, args) => {
    const { options, broadcast } = fixture();
    const controller = new AbortController();
    options.signal = controller.signal;
    broadcast.mockImplementation(async () => {
      controller.abort(new Error(body));
      return new Promise(() => {});
    });

    const result = await executeConfirmedTool(tool, args, options);
    expect(result.success).toBe(false);
    const suffix = ' The transaction may still commit on-chain. Check on-chain status before retrying; do not blindly retry.';
    expect(result.error).toContain(suffix);
    expectBounded(result.error!.slice(0, -suffix.length));
    expect(broadcast).toHaveBeenCalledOnce();
    expect(result.error).not.toContain('No transaction was sent');
  });

  it.each([actions[0], actions[2]])('retains definitive pre-broadcast cancellation facts for %s', async (tool, args) => {
    const { options, chain, broadcast } = fixture();
    const controller = new AbortController();
    options.signal = controller.signal;
    chain.getAddress.mockImplementation(async () => {
      controller.abort(new Error(body));
      return address;
    });

    const result = await executeConfirmedTool(tool, args, options);
    expect(result.success).toBe(false);
    const suffix = ' No transaction was sent.';
    expect(result.error).toContain(suffix);
    expectBounded(result.error!.slice(0, -suffix.length));
    expect(broadcast).not.toHaveBeenCalled();
    expect(result.error).not.toContain('may still commit');
  });

  it.each([actions[0], actions[2]])('keeps unknown submission facts conservative for %s cancellation', async (tool, args) => {
    const { options, chain, broadcast } = fixture();
    const error = new ManifestMCPError(ManifestMCPErrorCode.OPERATION_CANCELLED, body);
    chain.getAddress.mockRejectedValue(error);
    chain.getQueryClient.mockRejectedValue(error);

    const result = await executeConfirmedTool(tool, args, options);
    expect(result.success).toBe(false);
    const suffix = ' The transaction may still commit on-chain. Check on-chain status before retrying; do not blindly retry.';
    expect(result.error).toContain(suffix);
    expectBounded(result.error!.slice(0, -suffix.length));
    expect(broadcast).not.toHaveBeenCalled();
    expect(result.error).not.toContain('No transaction was sent');
  });

  it.each([actions[0], actions[2]])('preserves the short SDK cancellation message for %s', async (tool, args) => {
    const { options, chain } = fixture();
    const controller = new AbortController();
    options.signal = controller.signal;
    chain.getAddress.mockImplementation(async () => {
      controller.abort(new Error('cancelled'));
      return address;
    });

    const result = await executeConfirmedTool(tool, args, options);
    expect(result).toEqual({ success: false, error: 'Transaction was cancelled before broadcast (cancelled); no transaction was sent.' });
  });
});

describe('manifest-building SDK error boundaries', () => {
  it.each(['deploy_app', 'update_app'])('bounds real normalizePorts errors from image and stack %s planning', async (tool) => {
    const { options } = fixture();
    const port = `invalid\n\u0000\u202e${'🦕'.repeat(1_000)}`;
    for (const source of [{ image: 'nginx:latest', port }, { services: JSON.stringify({ web: { image: 'nginx:latest', port } }) }]) {
      const result = await executeTool(tool, { app_name: app.name, ...source }, options);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid port: "invalid ');
      expectBounded(result.error);
    }
  });
});
