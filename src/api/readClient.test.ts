import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
const mockDispose = vi.fn();

vi.mock('@manifest-network/manifest-sdk', () => ({
  createManifestReadClient: (...args: unknown[]) => mockCreate(...args),
}));
vi.mock('./config', () => ({ REST_URL: 'http://localhost:1317' }));
vi.mock('../config/chain', () => ({ CHAIN_ID: 'manifest-ledger-beta' }));

import { getReadClient, disposeReadClient } from './readClient';

beforeEach(async () => {
  await disposeReadClient(); // clear any cached clientPromise from a prior test
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({ dispose: mockDispose });
});

describe('getReadClient', () => {
  it('creates a query-only client with { chainId, restUrl } and NO rpcUrl', async () => {
    await getReadClient();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0] as { config: Record<string, unknown> };
    expect(arg.config.chainId).toBe('manifest-ledger-beta');
    expect(arg.config.restUrl).toBe('http://localhost:1317');
    expect(arg.config.rpcUrl).toBeUndefined();
  });

  it('caches the client across calls (single construction)', async () => {
    const a = await getReadClient();
    const b = await getReadClient();
    expect(a).toBe(b);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('resets the cache on construction failure so the next call rebuilds', async () => {
    mockCreate.mockRejectedValueOnce(new Error('boot fail'));
    await expect(getReadClient()).rejects.toThrow('boot fail');

    // The .catch nulled clientPromise; a subsequent call constructs afresh.
    mockCreate.mockResolvedValue({ dispose: mockDispose });
    await getReadClient();
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

describe('disposeReadClient', () => {
  it('disposes the resolved client and lets the next call rebuild', async () => {
    await getReadClient();
    await disposeReadClient();
    expect(mockDispose).toHaveBeenCalledTimes(1);
    await getReadClient();
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when no client was created', async () => {
    await disposeReadClient();
    expect(mockDispose).not.toHaveBeenCalled();
  });

  it('swallows a throwing dispose() and still lets the next call rebuild', async () => {
    const throwingDispose = vi.fn(() => {
      throw new Error('teardown boom');
    });
    mockCreate.mockResolvedValue({ dispose: throwingDispose });
    await getReadClient();

    await expect(disposeReadClient()).resolves.toBeUndefined();
    expect(throwingDispose).toHaveBeenCalledTimes(1);

    // Cache was cleared despite the throw, so the next call constructs afresh.
    await getReadClient();
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});
