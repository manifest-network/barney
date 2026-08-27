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
    const address = `manifest1${'q'.repeat(38)}`;
    const challenge = challenges.create(address, CONFIG.chainId);

    expect(challenges.consume(challenge.challengeId).message).toContain(CONFIG.chainId);
    expect(() => challenges.consume(challenge.challengeId)).toThrowError(AuthError);

    const expiring = challenges.create(address, CONFIG.chainId);
    now += CONFIG.challengeTtlMs + 1;
    expect(() => challenges.consume(expiring.challengeId)).toThrowError(AuthError);
  });

  it('binds sessions to both wallet and chain and gives the ledger a pseudonymous identity', () => {
    let now = Date.parse('2026-08-27T12:00:00Z');
    const sessions = new SessionStore(CONFIG, () => now);
    const address = `manifest1${'q'.repeat(38)}`;
    const session = sessions.create(address, CONFIG.chainId);

    expect(sessions.requireBound(session.id, address, CONFIG.chainId).id).toBe(session.id);
    expect(() => sessions.requireBound(session.id, `manifest1${'p'.repeat(38)}`, CONFIG.chainId)).toThrowError(AuthError);
    expect(() => sessions.requireBound(session.id, address, 'another-chain')).toThrowError(AuthError);
    expect(session.identityKey).toMatch(/^[a-f0-9]{64}$/);
    expect(session.identityKey).not.toContain(address);

    now += CONFIG.sessionTtlMs + 1;
    expect(() => sessions.get(session.id)).toThrowError(AuthError);
  });
});
