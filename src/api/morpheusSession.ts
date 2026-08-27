import { CHAIN_ID } from '../config/chain';
import type { SignResult } from '../ai/toolExecutor/types';

const API_BASE = '/api/morpheus';
const EXPIRY_SKEW_MS = 5_000;

export interface MorpheusAuthContext {
  walletAddress: string;
  signChallenge: (message: string) => Promise<SignResult>;
}

interface SessionResponse {
  authenticated: true;
  address: string;
  chainId: string;
  expiresAt: string;
}

interface ChallengeResponse {
  challengeId: string;
  message: string;
  address: string;
  chainId: string;
  expiresAt: string;
}

interface CachedSession {
  address: string;
  chainId: string;
  expiresAtMs: number;
}

let cachedSession: CachedSession | undefined;

export class MorpheusSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MorpheusSessionError';
  }
}

function identityHeaders(address: string): Record<string, string> {
  return {
    'X-Barney-Wallet-Address': address,
    'X-Barney-Chain-Id': CHAIN_ID,
  };
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new MorpheusSessionError('The inference authentication service returned an invalid response.');
  }
}

function validateSession(value: SessionResponse, address: string): CachedSession {
  const expiresAtMs = Date.parse(value.expiresAt);
  if (value.authenticated !== true
    || value.address !== address
    || value.chainId !== CHAIN_ID
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= Date.now()) {
    throw new MorpheusSessionError('The inference session was not bound to the active wallet and chain.');
  }
  return { address, chainId: CHAIN_ID, expiresAtMs };
}

function isFresh(address: string): boolean {
  return cachedSession?.address === address
    && cachedSession.chainId === CHAIN_ID
    && cachedSession.expiresAtMs > Date.now() + EXPIRY_SKEW_MS;
}

export function invalidateMorpheusSession(): void {
  cachedSession = undefined;
}

export async function ensureMorpheusSession(
  auth: MorpheusAuthContext,
  signal?: AbortSignal,
): Promise<void> {
  if (isFresh(auth.walletAddress)) return;

  const statusResponse = await fetch(`${API_BASE}/auth/status`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: identityHeaders(auth.walletAddress),
    signal,
  });
  if (statusResponse.ok) {
    cachedSession = validateSession(
      await parseJson<SessionResponse>(statusResponse),
      auth.walletAddress,
    );
    return;
  }
  if (statusResponse.status !== 401 && statusResponse.status !== 403) {
    throw new MorpheusSessionError('Inference authentication is temporarily unavailable.');
  }

  const challengeResponse = await fetch(`${API_BASE}/auth/challenge`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: auth.walletAddress, chainId: CHAIN_ID }),
    signal,
  });
  if (!challengeResponse.ok) {
    throw new MorpheusSessionError('Could not create a wallet authentication challenge.');
  }
  const challenge = await parseJson<ChallengeResponse>(challengeResponse);
  if (challenge.address !== auth.walletAddress
    || challenge.chainId !== CHAIN_ID
    || typeof challenge.challengeId !== 'string'
    || typeof challenge.message !== 'string'
    || Date.parse(challenge.expiresAt) <= Date.now()) {
    throw new MorpheusSessionError('The inference authentication challenge was invalid.');
  }

  const signed = await auth.signChallenge(challenge.message);
  if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');

  const sessionResponse = await fetch(`${API_BASE}/auth/session`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      pubKey: signed.pub_key.value,
      signature: signed.signature,
    }),
    signal,
  });
  if (!sessionResponse.ok) {
    throw new MorpheusSessionError('Wallet authentication failed. Please reconnect your wallet and try again.');
  }
  cachedSession = validateSession(
    await parseJson<SessionResponse>(sessionResponse),
    auth.walletAddress,
  );
}

export async function fetchWithMorpheusSession(
  auth: MorpheusAuthContext,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  await ensureMorpheusSession(auth, init.signal ?? undefined);
  const requestHeaders = new Headers(init.headers);
  for (const [name, value] of Object.entries(identityHeaders(auth.walletAddress))) {
    requestHeaders.set(name, value);
  }

  let response = await fetch(input, {
    ...init,
    credentials: 'same-origin',
    headers: requestHeaders,
  });
  if (response.status === 401 || response.headers.get('X-Barney-Auth-Required') === '1') {
    invalidateMorpheusSession();
    await ensureMorpheusSession(auth, init.signal ?? undefined);
    response = await fetch(input, {
      ...init,
      credentials: 'same-origin',
      headers: requestHeaders,
    });
  }
  return response;
}

export async function logoutMorpheusSession(): Promise<void> {
  invalidateMorpheusSession();
  await fetch(`${API_BASE}/auth/logout`, {
    method: 'DELETE',
    credentials: 'same-origin',
    keepalive: true,
  });
}
