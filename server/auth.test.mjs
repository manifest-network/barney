// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Secp256k1HdWallet } from '@cosmjs/amino';
import { toBase64 } from '@cosmjs/encoding';
import { AuthError, ChallengeStore, SessionStore, verifyAdr36 } from './auth.mjs';

async function walletSignature(wallet, address, message) {
  const signDoc = {
    chain_id: '',
    account_number: '0',
    sequence: '0',
    fee: { gas: '0', amount: [] },
    msgs: [{
      type: 'sign/MsgSignData',
      value: {
        signer: address,
        data: toBase64(new TextEncoder().encode(message)),
      },
    }],
    memo: '',
  };
  const result = await wallet.signAmino(address, signDoc);
  return {
    pubKey: result.signature.pub_key.value,
    signature: result.signature.signature,
  };
}

const CONFIG = {
  addressPrefix: 'manifest',
  audience: 'barney-test',
  chainId: 'manifest-test',
  challengeTtlMs: 30_000,
  sessionTtlMs: 60_000,
  maxChallenges: 10,
  maxSessions: 10,
  identityHmacKey: 'identity-key-that-is-long-enough-for-tests',
};

const ADDRESS = 'manifest1vk7rpvd0nu69z5n2t3xhyfrc06w0e90dxnjsjl';
const OTHER_ADDRESS = 'manifest1pgc5h7k5w6nwjkzdtv3scjxpj9u026t99spm8y';
const THIRD_ADDRESS = 'manifest1agmwm6kzh2pfw9xc0yptyrzkf48qk3rryq03z9';

describe('ADR-036 relay authentication', () => {
  it('verifies a real CosmJS ADR-036 signature and derives its Manifest address', async () => {
    const wallet = await Secp256k1HdWallet.generate(12, { prefix: 'manifest' });
    const [{ address }] = await wallet.getAccounts();
    const message = '{"type":"barney/morpheus-auth","chain_id":"manifest-test"}';
    const signed = await walletSignature(wallet, address, message);

    expect(() => verifyAdr36({
      address,
      message,
      ...signed,
      addressPrefix: 'manifest',
    })).not.toThrow();
  });

  it('rejects a signature whose public key belongs to another wallet', async () => {
    const wallet = await Secp256k1HdWallet.generate(12, { prefix: 'manifest' });
    const other = await Secp256k1HdWallet.generate(12, { prefix: 'manifest' });
    const [{ address }] = await wallet.getAccounts();
    const [{ address: otherAddress }] = await other.getAccounts();
    const signed = await walletSignature(wallet, address, 'challenge');

    expect(() => verifyAdr36({
      address: otherAddress,
      message: 'challenge',
      ...signed,
      addressPrefix: 'manifest',
    })).toThrowError(AuthError);
  });

  it('consumes a challenge exactly once and expires it against the injected clock', () => {
    let now = Date.parse('2026-08-27T12:00:00Z');
    const challenges = new ChallengeStore(CONFIG, () => now);
    const challenge = challenges.create(ADDRESS, CONFIG.chainId);

    expect(challenges.consume(challenge.challengeId).message).toContain(CONFIG.chainId);
    expect(() => challenges.consume(challenge.challengeId)).toThrowError(AuthError);

    const expiring = challenges.create(ADDRESS, CONFIG.chainId);
    now += CONFIG.challengeTtlMs + 1;
    expect(() => challenges.consume(expiring.challengeId)).toThrowError(AuthError);
  });

  it('binds sessions to both wallet and chain and gives the ledger a pseudonymous identity', () => {
    let now = Date.parse('2026-08-27T12:00:00Z');
    const sessions = new SessionStore(CONFIG, () => now);
    const session = sessions.create(ADDRESS, CONFIG.chainId);

    expect(sessions.requireBound(session.id, ADDRESS, CONFIG.chainId).id).toBe(session.id);
    expect(() => sessions.requireBound(session.id, OTHER_ADDRESS, CONFIG.chainId)).toThrowError(AuthError);
    expect(() => sessions.requireBound(session.id, ADDRESS, 'another-chain')).toThrowError(AuthError);
    expect(session.identityKey).toMatch(/^[a-f0-9]{64}$/);
    expect(session.identityKey).not.toContain(ADDRESS);

    now += CONFIG.sessionTtlMs + 1;
    expect(() => sessions.get(session.id)).toThrowError(AuthError);
  });

  it('rejects a syntactically plausible Manifest address with a bad checksum', () => {
    const challenges = new ChallengeStore(CONFIG);
    const invalid = `${ADDRESS.slice(0, -1)}${ADDRESS.endsWith('q') ? 'p' : 'q'}`;

    expect(() => challenges.create(invalid, CONFIG.chainId)).toThrowError(AuthError);
  });

  it('bounds challenges without letting one wallet exhaust a global lockout bucket', () => {
    const challenges = new ChallengeStore({ ...CONFIG, maxChallenges: 2 });
    const first = challenges.create(ADDRESS, CONFIG.chainId);
    const replacement = challenges.create(ADDRESS, CONFIG.chainId);
    expect(() => challenges.consume(first.challengeId)).toThrowError(AuthError);

    const second = challenges.create(OTHER_ADDRESS, CONFIG.chainId);
    const third = challenges.create(THIRD_ADDRESS, CONFIG.chainId);
    expect(() => challenges.consume(replacement.challengeId)).toThrowError(AuthError);
    expect(challenges.consume(second.challengeId).address).toBe(OTHER_ADDRESS);
    expect(challenges.consume(third.challengeId).address).toBe(THIRD_ADDRESS);
  });

  it('keeps one bounded session per wallet and reports replaced sessions for cancellation', () => {
    const sessions = new SessionStore({ ...CONFIG, maxSessions: 2 });
    const first = sessions.create(ADDRESS, CONFIG.chainId);
    const second = sessions.create(OTHER_ADDRESS, CONFIG.chainId);
    const evictions = [];

    const replacement = sessions.create(ADDRESS, CONFIG.chainId, (id, reason) => {
      evictions.push({ id, reason });
    });
    expect(evictions).toEqual([{ id: first.id, reason: 'session_replaced' }]);
    expect(() => sessions.get(first.id)).toThrowError(AuthError);
    expect(sessions.get(second.id).id).toBe(second.id);

    sessions.create(THIRD_ADDRESS, CONFIG.chainId, (id, reason) => {
      evictions.push({ id, reason });
    });
    expect(evictions[1]).toEqual({ id: second.id, reason: 'session_capacity_replaced' });
    expect(sessions.get(replacement.id).id).toBe(replacement.id);
  });
});
