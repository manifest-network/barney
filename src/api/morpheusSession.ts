import { CHAIN_ID } from '../config/chain';
import type { SignResult } from '../ai/toolExecutor/types';

const API_BASE = '/api/morpheus';
const EXPIRY_SAFETY_MARGIN_MS = 5_000;

export interface MorpheusAuthContext {
  walletAddress: string;
  signChallenge: (message: string) => Promise<SignResult>;
}

interface SessionResponse {
  authenticated: true;
  address: string;
  chainId: string;
  expiresAt: string;
  expiresInSeconds: number;
}

interface ChallengeResponse {
  challengeId: string;
  message: string;
  address: string;
  chainId: string;
  expiresAt: string;
  expiresInSeconds: number;
}

interface CachedSession {
  address: string;
  chainId: string;
  expiresAtMs: number;
}

let cachedSession: CachedSession | undefined;
let sessionEpoch = 0;
let inFlightSession: {
  address: string;
  epoch: number;
  controller: AbortController;
  promise: Promise<void>;
} | undefined;

export class MorpheusSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MorpheusSessionError';
  }
}

export class MorpheusRequestTimeoutError extends Error {
  constructor() {
    super('The inference request timed out.');
    this.name = 'MorpheusRequestTimeoutError';
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
  if (value.authenticated !== true
    || value.address !== address
    || value.chainId !== CHAIN_ID) {
    throw new MorpheusSessionError('The inference session was not bound to the active wallet and chain.');
  }
  if (!Number.isFinite(Date.parse(value.expiresAt))
    || !Number.isSafeInteger(value.expiresInSeconds)
    || value.expiresInSeconds <= 0
    || value.expiresInSeconds > 86_400) {
    throw new MorpheusSessionError('The inference authentication service returned an invalid session expiry.');
  }
  // The relay is authoritative for expiry. Cache its relative TTL against the
  // browser clock so client clock skew cannot force an endless re-sign loop.
  return {
    address,
    chainId: CHAIN_ID,
    expiresAtMs: Date.now() + value.expiresInSeconds * 1000,
  };
}

function isFresh(address: string): boolean {
  return cachedSession?.address === address
    && cachedSession.chainId === CHAIN_ID
    && cachedSession.expiresAtMs > Date.now() + EXPIRY_SAFETY_MARGIN_MS;
}

export function invalidateMorpheusSession(): void {
  cachedSession = undefined;
  sessionEpoch += 1;
  inFlightSession?.controller.abort();
  inFlightSession = undefined;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

async function signChallengeBeforeExpiry(
  auth: MorpheusAuthContext,
  challenge: ChallengeResponse,
): Promise<SignResult> {
  const challengeTtlMs = challenge.expiresInSeconds * 1000;
  const safetyMarginMs = Math.min(EXPIRY_SAFETY_MARGIN_MS, challengeTtlMs / 2);
  const timeoutMs = challengeTtlMs - safetyMarginMs;
  const timeoutError = () => new MorpheusSessionError(
    'Session timeout: the wallet signature did not complete before the challenge deadline. Please try again.',
  );
  if (timeoutMs <= 0) throw timeoutError();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      auth.signChallenge(challenge.message),
      new Promise<never>((_, reject) => {
        // The relay's relative TTL avoids browser/server clock skew. End the
        // signing wait early so the session request has time to reach it.
        timeoutId = setTimeout(
          () => reject(timeoutError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function waitForSession(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function establishMorpheusSession(
  auth: MorpheusAuthContext,
  signal?: AbortSignal,
): Promise<CachedSession> {
  const statusResponse = await fetch(`${API_BASE}/auth/status`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: identityHeaders(auth.walletAddress),
    signal,
  });
  if (statusResponse.ok) {
    return validateSession(
      await parseJson<SessionResponse>(statusResponse),
      auth.walletAddress,
    );
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
    || !Number.isFinite(Date.parse(challenge.expiresAt))
    || !Number.isSafeInteger(challenge.expiresInSeconds)
    || challenge.expiresInSeconds <= 0
    || challenge.expiresInSeconds > 600) {
    throw new MorpheusSessionError('The inference authentication challenge was invalid.');
  }

  const signed = await signChallengeBeforeExpiry(auth, challenge);
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
  return validateSession(
    await parseJson<SessionResponse>(sessionResponse),
    auth.walletAddress,
  );
}

export async function ensureMorpheusSession(
  auth: MorpheusAuthContext,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  if (isFresh(auth.walletAddress)) return;
  const epoch = sessionEpoch;
  if (inFlightSession?.address === auth.walletAddress && inFlightSession.epoch === epoch) {
    return waitForSession(inFlightSession.promise, signal);
  }

  // The deduplicated handshake has its own lifecycle. Each caller races it
  // against that caller's signal below; wallet/session invalidation is the only
  // event that cancels the shared network work for every waiter.
  const controller = new AbortController();
  const promise = establishMorpheusSession(auth, controller.signal).then((session) => {
    if (sessionEpoch !== epoch) {
      throw new MorpheusSessionError('The active wallet changed during inference authentication.');
    }
    cachedSession = session;
  });
  const current = {
    address: auth.walletAddress,
    epoch,
    controller,
    promise,
  };
  inFlightSession = current;
  const clearInFlight = () => {
    if (inFlightSession === current) inFlightSession = undefined;
  };
  void promise.then(clearInFlight, clearInFlight);
  return waitForSession(promise, signal);
}

async function timedFetch(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number | undefined,
): Promise<Response> {
  if (!timeoutMs) return fetch(input, init);
  const abort = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => abort.abort(init.signal?.reason);
  if (init.signal?.aborted) onExternalAbort();
  else init.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: abort.signal });
  } catch (error) {
    if (timedOut) throw new MorpheusRequestTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function fetchWithMorpheusSession(
  auth: MorpheusAuthContext,
  input: RequestInfo | URL,
  init: RequestInit,
  requestTimeoutMs?: number,
): Promise<Response> {
  await ensureMorpheusSession(auth, init.signal ?? undefined);
  const requestHeaders = new Headers(init.headers);
  for (const [name, value] of Object.entries(identityHeaders(auth.walletAddress))) {
    requestHeaders.set(name, value);
  }

  let response = await timedFetch(input, {
    ...init,
    credentials: 'same-origin',
    headers: requestHeaders,
  }, requestTimeoutMs);
  if (response.status === 401 || response.headers.get('X-Barney-Auth-Required') === '1') {
    invalidateMorpheusSession();
    await ensureMorpheusSession(auth, init.signal ?? undefined);
    response = await timedFetch(input, {
      ...init,
      credentials: 'same-origin',
      headers: requestHeaders,
    }, requestTimeoutMs);
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
