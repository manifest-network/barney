import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/chain', () => ({ CHAIN_ID: 'manifest-test' }));

import {
  MorpheusSessionError,
  ensureMorpheusSession,
  invalidateMorpheusSession,
  logoutMorpheusSession,
} from './morpheusSession';

const ADDRESS = 'manifest1wallet';
const EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();
const AUTH = {
  walletAddress: ADDRESS,
  signChallenge: vi.fn().mockResolvedValue({
    pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'pub-key' },
    signature: 'signature',
  }),
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Morpheus wallet session client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateMorpheusSession();
  });

  it('turns a one-time server challenge into an HttpOnly wallet session', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'missing' }))
      .mockResolvedValueOnce(jsonResponse(200, {
        challengeId: 'challenge-id',
        message: 'chain-bound challenge',
        address: ADDRESS,
        chainId: 'manifest-test',
        expiresAt: EXPIRES_AT,
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        authenticated: true,
        address: ADDRESS,
        chainId: 'manifest-test',
        expiresAt: EXPIRES_AT,
      })));

    await ensureMorpheusSession(AUTH);

    expect(AUTH.signChallenge).toHaveBeenCalledWith('chain-bound challenge');
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      '/api/morpheus/auth/status',
      '/api/morpheus/auth/challenge',
      '/api/morpheus/auth/session',
    ]);
    expect(JSON.parse(calls[1][1]?.body as string)).toEqual({
      address: ADDRESS,
      chainId: 'manifest-test',
    });
    expect(JSON.parse(calls[2][1]?.body as string)).toEqual({
      challengeId: 'challenge-id',
      pubKey: 'pub-key',
      signature: 'signature',
    });

    await ensureMorpheusSession(AUTH);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reuses an unexpired server session after a page-local cache miss', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {
      authenticated: true,
      address: ADDRESS,
      chainId: 'manifest-test',
      expiresAt: EXPIRES_AT,
    })));

    await ensureMorpheusSession(AUTH);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(AUTH.signChallenge).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual({
      'X-Barney-Wallet-Address': ADDRESS,
      'X-Barney-Chain-Id': 'manifest-test',
    });
  });

  it('rejects a session response bound to another wallet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {
      authenticated: true,
      address: 'manifest1other',
      chainId: 'manifest-test',
      expiresAt: EXPIRES_AT,
    })));

    await expect(ensureMorpheusSession(AUTH)).rejects.toBeInstanceOf(MorpheusSessionError);
  });

  it('clears the local session cache and asks the server to revoke its cookie on logout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await logoutMorpheusSession();

    expect(fetch).toHaveBeenCalledWith('/api/morpheus/auth/logout', {
      method: 'DELETE',
      credentials: 'same-origin',
      keepalive: true,
    });
  });
});
