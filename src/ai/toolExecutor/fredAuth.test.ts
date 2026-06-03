import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils', () => ({ getProviderAuthToken: vi.fn().mockResolvedValue('auth-tok') }));
vi.mock('../../api/provider-api', () => ({
  createLeaseDataSignMessage: vi.fn().mockReturnValue('lease-data-msg'),
  createAuthToken: vi.fn().mockReturnValue('lease-data-tok'),
}));

import { makeFredAuthTokens, getFredQueryClient } from './fredAuth';
import { getProviderAuthToken } from './utils';
import { createLeaseDataSignMessage, createAuthToken } from '../../api/provider-api';
import type { SignArbitraryFn } from './types';

const signArbitrary: SignArbitraryFn = vi
  .fn()
  .mockResolvedValue({ pub_key: { type: 't', value: 'pk' }, signature: 'sig' });

describe('makeFredAuthTokens', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds a 2-arg getAuthToken delegating to getProviderAuthToken', async () => {
    const { getAuthToken } = makeFredAuthTokens(signArbitrary);
    await expect(getAuthToken('addr', 'lease')).resolves.toBe('auth-tok');
    expect(getProviderAuthToken).toHaveBeenCalledWith('addr', 'lease', signArbitrary);
  });

  it('builds a 3-arg getLeaseDataAuthToken that signs the lease-data message + binds the meta-hash', async () => {
    const metaHash = 'a'.repeat(64);
    const { getLeaseDataAuthToken } = makeFredAuthTokens(signArbitrary);
    await expect(getLeaseDataAuthToken('addr', 'lease', metaHash)).resolves.toBe('lease-data-tok');
    expect(createLeaseDataSignMessage).toHaveBeenCalledWith('lease', metaHash, expect.any(Number));
    expect(signArbitrary).toHaveBeenCalledWith('addr', 'lease-data-msg');
    expect(createAuthToken).toHaveBeenCalledWith('addr', 'lease', expect.any(Number), 'pk', 'sig', metaHash);
  });
});

describe('getFredQueryClient', () => {
  it('delegates to clientManager.getQueryClient()', async () => {
    const queryClient = {} as never;
    const clientManager = { getQueryClient: vi.fn().mockResolvedValue(queryClient) } as never;
    await expect(getFredQueryClient(clientManager)).resolves.toBe(queryClient);
  });
});
