// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compileFunction } from 'node:vm';
import { ics23, calculateExistenceRoot, tendermintSpec, verifyMembership } from '@confio/ics23';
import { Secp256k1Wallet, serializeSignDoc } from '@cosmjs/amino';
import { Secp256k1, Secp256k1Signature, sha256 } from '@cosmjs/crypto';
import { fromBase64 } from '@cosmjs/encoding';
import { DirectSecp256k1Wallet, makeSignBytes } from '@cosmjs/proto-signing';
import type { Web3AuthSigner } from '@cosmos-kit/web3auth/esm/extension/signer.js';
import type { FromWorkerMessage } from '@cosmos-kit/web3auth/esm/extension/types.js';
import { makeADR36AminoSignDoc, verifyADR36Amino } from '@keplr-wallet/cosmos';
import { SignDoc as KeplrSignDoc } from '@keplr-wallet/proto-types/cosmos/tx/v1beta1/tx';
import * as eccrypto from '@toruslabs/eccrypto';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const CHAIN_ID = 'manifest-test-1';
const PREFIX = 'manifest';
const fixtureKey = (byte: number) => Buffer.alloc(32, byte);
const require = createRequire(import.meta.url);
type SignerUtils = typeof import('@cosmos-kit/web3auth/esm/extension/utils.js');

// The published connector uses extensionless ESM imports, which Node cannot
// resolve. Transform the actual installed module without copying its behavior.
// Only worker transport and unused login UI are substituted; crypto stays real.
function loadInstalledModule<T>(specifier: string, imports: Record<string, unknown>): T {
  const filename = require.resolve(specifier);
  const moduleRequire = createRequire(filename);
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const evaluate = compileFunction(source, ['require', 'exports'], { filename });
  evaluate((name: string) => Object.hasOwn(imports, name) ? imports[name] : moduleRequire(name), exports);
  return exports as T;
}

const utils = loadInstalledModule<SignerUtils>(
  '@cosmos-kit/web3auth/esm/extension/utils.js',
  { '@web3auth/modal': {} },
);

async function signerFixture(tamperResponse = false) {
  // Public deterministic test keys, unrelated to any real wallet.
  const wallet = await Secp256k1Wallet.fromKey(fixtureKey(1), PREFIX);
  const directWallet = await DirectSecp256k1Wallet.fromKey(fixtureKey(1), PREFIX);
  const [account] = await wallet.getAccounts();
  const clientKey = fixtureKey(2);
  const workerKey = fixtureKey(3);
  const transport = vi.fn<SignerUtils['sendAndListenOnce']>(async (_worker, message, callback) => {
    if (message.type !== 'request_sign') throw new Error('Unexpected worker request');
    await eccrypto.verify(eccrypto.getPublic(clientKey), utils.hashObject(message.payload), Buffer.from(message.signature));
    const data = message.payload.data;
    const response: Extract<FromWorkerMessage, { type: 'sign' }>['payload']['response'] = data.type === 'amino'
      ? { type: 'amino', value: await wallet.signAmino(message.payload.signerAddress, data.value) }
      : { type: 'direct', value: await directWallet.signDirect(message.payload.signerAddress, data.value) };
    const payload = { id: message.payload.id, response };
    const signature = await eccrypto.sign(workerKey, utils.hashObject(payload));
    if (tamperResponse) signature[signature.length - 1] ^= 1;
    expect(await callback({ type: 'sign', payload, signature })).toBe(true);
  });
  const { Web3AuthSigner: Signer } = loadInstalledModule<{ Web3AuthSigner: typeof Web3AuthSigner }>(
    '@cosmos-kit/web3auth/esm/extension/signer.js',
    { './utils': { ...utils, sendAndListenOnce: transport } },
  );
  const promptSign = vi.fn(async () => true);
  const chain = { chain_id: CHAIN_ID, bech32_prefix: PREFIX } as ConstructorParameters<typeof Signer>[0];
  const signer = new Signer(chain, {} as Worker, clientKey, eccrypto.getPublic(workerKey), promptSign);
  return { signer, account, promptSign, transport };
}

describe('dependency compatibility for generated protobuf codecs', () => {
  it('preserves exact sign bytes and the maximum uint64 through the Keplr generated codec', () => {
    const doc = KeplrSignDoc.fromPartial({
      bodyBytes: Uint8Array.from([1, 2, 3]),
      authInfoBytes: Uint8Array.from([4, 5]),
      chainId: CHAIN_ID,
      accountNumber: '18446744073709551615',
    });
    // Independent wire-format fixture: field 4 is the maximum unsigned varint.
    const expected = Buffer.from('0a03010203120204051a0f6d616e69666573742d746573742d3120ffffffffffffffffff01', 'hex');
    expect(Buffer.from(KeplrSignDoc.encode(doc).finish())).toEqual(expected);
    const decoded = KeplrSignDoc.decode(expected);
    expect(decoded.accountNumber).toBe('18446744073709551615');
    expect(Buffer.from(KeplrSignDoc.encode(decoded).finish())).toEqual(expected);
    expect(Buffer.from(makeSignBytes({ ...doc, accountNumber: BigInt(doc.accountNumber) }))).toEqual(expected);
  });

  it('preserves verification of a generated ICS23 commitment proof', () => {
    const key = Uint8Array.from([1, 2, 3]);
    const value = Uint8Array.from([4, 5, 6]);
    const existence = { key, value, leaf: tendermintSpec.leafSpec, path: [] };
    const root = calculateExistenceRoot(existence);
    const proof = ics23.CommitmentProof.decode(ics23.CommitmentProof.encode({ exist: existence }).finish());
    expect(verifyMembership(proof, tendermintSpec, root, key, value)).toBe(true);
    expect(verifyMembership(proof, tendermintSpec, root, key, Uint8Array.from([9]))).toBe(false);
  });
});

describe('installed Web3Auth signer compatibility', () => {
  it('accepts empty-chain ADR-036 and returns a verifiable signature for the deterministic account', async () => {
    const { signer, account, transport, promptSign } = await signerFixture();
    expect(account.address).toBe('manifest10xcqpzrky6eff2g52qdye53xkk9jxkvrqzct5t');
    expect(Buffer.from(account.pubkey).toString('hex')).toBe('031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f');
    const proof = 'barney dependency compatibility proof';
    const doc = makeADR36AminoSignDoc(account.address, proof);
    expect(doc.chain_id).toBe('');
    const result = await signer.signAmino(account.address, doc);
    expect(result.signed).toEqual(doc);
    expect(verifyADR36Amino(PREFIX, account.address, proof, fromBase64(result.signature.pub_key.value), fromBase64(result.signature.signature))).toBe(true);
    expect(promptSign).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('signs an Amino transaction for the configured chain', async () => {
    const { signer, account } = await signerFixture();
    const doc = { ...makeADR36AminoSignDoc(account.address, 'fixture'), chain_id: CHAIN_ID };
    const result = await signer.signAmino(account.address, doc);
    expect(await Secp256k1.verifySignature(
      Secp256k1Signature.fromFixedLength(fromBase64(result.signature.signature)),
      sha256(serializeSignDoc(doc)),
      account.pubkey,
    )).toBe(true);
  });

  it('signs a direct transaction without losing a large account number', async () => {
    const { signer, account } = await signerFixture();
    const doc = { bodyBytes: new Uint8Array([1, 2]), authInfoBytes: new Uint8Array([3, 4]), chainId: CHAIN_ID, accountNumber: 9007199254740993n };
    const result = await signer.signDirect(account.address, doc);
    expect(result.signed.accountNumber).toBe(doc.accountNumber);
    expect(await Secp256k1.verifySignature(
      Secp256k1Signature.fromFixedLength(fromBase64(result.signature.signature)),
      sha256(makeSignBytes(doc)),
      account.pubkey,
    )).toBe(true);
  });

  it.each(['amino', 'direct'] as const)('rejects a foreign-chain %s request before prompting or using the worker', async (type) => {
    const { signer, account, promptSign, transport } = await signerFixture();
    const request = type === 'amino'
      ? signer.signAmino(account.address, { ...makeADR36AminoSignDoc(account.address, 'fixture'), chain_id: 'foreign-chain' })
      : signer.signDirect(account.address, { bodyBytes: new Uint8Array(), authInfoBytes: new Uint8Array(), chainId: 'foreign-chain', accountNumber: 0n });
    await expect(request).rejects.toThrow('Chain ID mismatch');
    expect(promptSign).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated worker response', async () => {
    const { signer, account } = await signerFixture(true);
    await expect(signer.signAmino(account.address, makeADR36AminoSignDoc(account.address, 'fixture'))).rejects.toThrow();
  });
});
