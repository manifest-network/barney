import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/chain', () => ({ CHAIN_ID: 'manifest-test' }));

import {
  MorpheusSessionError,
  ensureMorpheusSession,
  fetchWithMorpheusSession,
  invalidateMorpheusSession,
  logoutMorpheusSession,
} from './morpheusSession';

const ADDRESS = 'manifest1wallet';
const EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();
const SIGNED_CHALLENGE = {
  pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'pub-key' },
  signature: 'signature',
};
const AUTH = {
  walletAddress: ADDRESS,
  signChallenge: vi.fn().mockResolvedValue(SIGNED_CHALLENGE),
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

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
        expiresInSeconds: 120,
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        authenticated: true,
        address: ADDRESS,
        chainId: 'manifest-test',
        expiresAt: EXPIRES_AT,
        expiresInSeconds: 60,
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

  it('stops wallet signing before the relay challenge expires', async () => {
    vi.useFakeTimers();
    let resolveSignature: ((signature: typeof SIGNED_CHALLENGE) => void) | undefined;
    const signChallenge = vi.fn(() => new Promise<typeof SIGNED_CHALLENGE>((resolve) => {
      resolveSignature = resolve;
    }));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'missing' }))
      .mockResolvedValueOnce(jsonResponse(200, {
        challengeId: 'challenge-id',
        message: 'chain-bound challenge',
        address: ADDRESS,
        chainId: 'manifest-test',
        expiresAt: EXPIRES_AT,
        expiresInSeconds: 10,
      })));

    const session = ensureMorpheusSession({ walletAddress: ADDRESS, signChallenge });
    let rejected = false;
    void session.catch(() => { rejected = true; });
    const rejection = expect(session).rejects.toThrow(
      'Session timeout: the wallet signature did not complete before the challenge deadline.',
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rejected).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(rejected).toBe(true);
    resolveSignature?.(SIGNED_CHALLENGE);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reuses an unexpired server session after a page-local cache miss', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {
      authenticated: true,
      address: ADDRESS,
      chainId: 'manifest-test',
      expiresAt: EXPIRES_AT,
      expiresInSeconds: 60,
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
      expiresInSeconds: 60,
    })));

    await expect(ensureMorpheusSession(AUTH)).rejects.toBeInstanceOf(MorpheusSessionError);
  });

  it('deduplicates concurrent challenge and signature work for the same wallet', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith('/status')) return jsonResponse(401, { error: 'missing' });
      if (url.endsWith('/challenge')) {
        return jsonResponse(200, {
          challengeId: 'challenge-id',
          message: 'chain-bound challenge',
          address: ADDRESS,
          chainId: 'manifest-test',
          expiresAt: EXPIRES_AT,
          expiresInSeconds: 120,
        });
      }
      return jsonResponse(200, {
        authenticated: true,
        address: ADDRESS,
        chainId: 'manifest-test',
        expiresAt: EXPIRES_AT,
        expiresInSeconds: 60,
      });
    }));

    await Promise.all([
      ensureMorpheusSession(AUTH),
      ensureMorpheusSession(AUTH),
    ]);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(AUTH.signChallenge).toHaveBeenCalledTimes(1);
  });

  it('isolates each caller abort signal while sharing session establishment', async () => {
    let resolveStatus: ((response: Response) => void) | undefined;
    let handshakeSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      handshakeSignal = init?.signal;
      return new Promise<Response>((resolve, reject) => {
        resolveStatus = resolve;
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      });
    }));
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = ensureMorpheusSession(AUTH, firstController.signal);
    const firstRejection = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = ensureMorpheusSession(AUTH, secondController.signal);
    firstController.abort();

    await firstRejection;
    expect(handshakeSignal).not.toBe(firstController.signal);
    expect(handshakeSignal?.aborted).toBe(false);
    resolveStatus?.(jsonResponse(200, {
      authenticated: true,
      address: ADDRESS,
      chainId: 'manifest-test',
      expiresAt: EXPIRES_AT,
      expiresInSeconds: 60,
    }));
    await expect(second).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the relay relative TTL instead of comparing expiry to a skewed browser clock', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {
      authenticated: true,
      address: ADDRESS,
      chainId: 'manifest-test',
      expiresAt: '2000-01-01T00:00:00.000Z',
      expiresInSeconds: 60,
    })));

    await ensureMorpheusSession(AUTH);
    await ensureMorpheusSession(AUTH);

    expect(fetch).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('starts the request timeout only after session establishment completes', async () => {
    vi.useFakeTimers();
    let resolveStatus: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString().endsWith('/status')) {
        return new Promise<Response>((resolve) => {
          resolveStatus = () => resolve(jsonResponse(200, {
            authenticated: true,
            address: ADDRESS,
            chainId: 'manifest-test',
            expiresAt: EXPIRES_AT,
            expiresInSeconds: 60,
          }));
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      });
    }));

    const request = fetchWithMorpheusSession(AUTH, '/api/morpheus/chat/completions', {
      method: 'POST',
    }, 50);
    const rejection = expect(request).rejects.toMatchObject({ name: 'MorpheusRequestTimeoutError' });
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(1);

    resolveStatus?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
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
