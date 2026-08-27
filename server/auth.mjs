import {
  createHash,
  createHmac,
  createPublicKey,
  ECDH,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

const ADR36_TYPE = 'sign/MsgSignData';
const SESSION_COOKIE_SECURE = '__Secure-barney_morpheus_session';
const SESSION_COOKIE_LOCAL = 'barney_morpheus_session';

export class AuthError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.reason = reason;
  }
}

function base64Bytes(value, expectedLengths, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new AuthError(401, 'invalid_signature', `Invalid ${field}`);
  }
  const bytes = Buffer.from(value, 'base64');
  const canonical = bytes.toString('base64').replace(/=+$/, '');
  if (canonical !== value.replace(/=+$/, '') || !expectedLengths.includes(bytes.length)) {
    throw new AuthError(401, 'invalid_signature', `Invalid ${field}`);
  }
  return bytes;
}

function canonicalAdr36SignBytes(address, message) {
  // @cosmjs/amino serializeSignDoc recursively sorts keys. Keeping every object
  // below in lexical key order produces the exact ADR-036 bytes without adding
  // the full browser SDK dependency to the runtime relay.
  const signDoc = {
    account_number: '0',
    chain_id: '',
    fee: {
      amount: [],
      gas: '0',
    },
    memo: '',
    msgs: [{
      type: ADR36_TYPE,
      value: {
        data: Buffer.from(message, 'utf8').toString('base64'),
        signer: address,
      },
    }],
    sequence: '0',
  };
  return Buffer.from(JSON.stringify(signDoc), 'utf8');
}

function derInteger(fixed) {
  let offset = 0;
  while (offset < fixed.length - 1 && fixed[offset] === 0) offset += 1;
  let value = fixed.subarray(offset);
  if ((value[0] & 0x80) !== 0) value = Buffer.concat([Buffer.from([0]), value]);
  return Buffer.concat([Buffer.from([0x02, value.length]), value]);
}

function compactSignatureToDer(signature) {
  const r = derInteger(signature.subarray(0, 32));
  const s = derInteger(signature.subarray(32, 64));
  const body = Buffer.concat([r, s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function secp256k1PublicKey(pubKey) {
  let uncompressed;
  try {
    uncompressed = Buffer.from(ECDH.convertKey(pubKey, 'secp256k1', undefined, undefined, 'uncompressed'));
  } catch {
    throw new AuthError(401, 'invalid_signature', 'Invalid public key');
  }
  // SubjectPublicKeyInfo(ecPublicKey, secp256k1) + uncompressed EC point.
  const spkiPrefix = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex');
  return createPublicKey({
    key: Buffer.concat([spkiPrefix, uncompressed]),
    format: 'der',
    type: 'spki',
  });
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < generators.length; i += 1) {
      if (((top >>> i) & 1) !== 0) checksum ^= generators[i];
    }
  }
  return checksum >>> 0;
}

function bech32HrpExpand(prefix) {
  return [
    ...[...prefix].map((char) => char.charCodeAt(0) >>> 5),
    0,
    ...[...prefix].map((char) => char.charCodeAt(0) & 31),
  ];
}

function convertBits(bytes, fromBits, toBits) {
  let accumulator = 0;
  let bits = 0;
  const result = [];
  const mask = (1 << toBits) - 1;
  for (const byte of bytes) {
    accumulator = (accumulator << fromBits) | byte;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((accumulator >>> bits) & mask);
    }
  }
  if (bits > 0) result.push((accumulator << (toBits - bits)) & mask);
  return result;
}

function pubKeyToAddress(pubKey, prefix) {
  const sha = createHash('sha256').update(pubKey).digest();
  const payload = createHash('ripemd160').update(sha).digest();
  const words = convertBits(payload, 8, 5);
  const checksumInput = [...bech32HrpExpand(prefix), ...words, 0, 0, 0, 0, 0, 0];
  const checksum = bech32Polymod(checksumInput) ^ 1;
  const checksumWords = Array.from({ length: 6 }, (_, index) => (checksum >>> (5 * (5 - index))) & 31);
  return `${prefix}1${[...words, ...checksumWords].map((word) => BECH32_CHARSET[word]).join('')}`;
}

function equalText(left, right) {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function verifyAdr36({ address, message, pubKey: encodedPubKey, signature: encodedSignature, addressPrefix }) {
  const pubKey = base64Bytes(encodedPubKey, [33, 65], 'public key');
  const signature = base64Bytes(encodedSignature, [64], 'signature');
  const derivedAddress = pubKeyToAddress(pubKey.length === 33
    ? pubKey
    : Buffer.from(ECDH.convertKey(pubKey, 'secp256k1', undefined, undefined, 'compressed')), addressPrefix);
  if (!equalText(derivedAddress, address)) {
    throw new AuthError(401, 'wallet_mismatch', 'The signature does not belong to the requested wallet');
  }

  const valid = verifySignature(
    'sha256',
    canonicalAdr36SignBytes(address, message),
    secp256k1PublicKey(pubKey),
    compactSignatureToDer(signature),
  );
  if (!valid) throw new AuthError(401, 'invalid_signature', 'Invalid wallet signature');
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function validateAddressShape(address, prefix) {
  if (typeof address !== 'string'
    || address !== address.toLowerCase()
    || address.length !== prefix.length + 39
    || !address.startsWith(`${prefix}1`)) {
    throw new AuthError(400, 'invalid_address', 'Invalid wallet address');
  }
  const words = [...address.slice(prefix.length + 1)].map((char) => BECH32_CHARSET.indexOf(char));
  if (words.some((word) => word < 0)
    || words.length !== 38
    || bech32Polymod([...bech32HrpExpand(prefix), ...words]) !== 1) {
    throw new AuthError(400, 'invalid_address', 'Invalid wallet address');
  }
}

function challengeMessage({ audience, chainId, address, challengeId, nonce, issuedAt, expiresAt }) {
  return JSON.stringify({
    type: 'barney/morpheus-auth',
    version: 1,
    audience,
    chain_id: chainId,
    address,
    challenge_id: challengeId,
    nonce,
    issued_at: new Date(issuedAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  });
}

export class ChallengeStore {
  constructor(config, now = () => Date.now()) {
    this.config = config;
    this.now = now;
    this.challenges = new Map();
    this.byAddress = new Map();
  }

  delete(id) {
    const challenge = this.challenges.get(id);
    this.challenges.delete(id);
    if (challenge && this.byAddress.get(challenge.address) === id) {
      this.byAddress.delete(challenge.address);
    }
  }

  prune() {
    const now = this.now();
    for (const [id, challenge] of this.challenges) {
      // Fixed TTLs preserve insertion/expiry order, so pruning stops at the
      // first live entry instead of walking an attacker-sized map every time.
      if (challenge.expiresAt > now) break;
      this.delete(id);
    }
  }

  create(address, chainId) {
    validateAddressShape(address, this.config.addressPrefix);
    if (chainId !== this.config.chainId) {
      throw new AuthError(403, 'chain_mismatch', 'Wallet is connected to the wrong chain');
    }
    this.prune();
    const priorId = this.byAddress.get(address);
    if (priorId) this.delete(priorId);
    while (this.challenges.size >= this.config.maxChallenges) {
      const oldestId = this.challenges.keys().next().value;
      if (!oldestId) break;
      this.delete(oldestId);
    }

    const issuedAt = this.now();
    const challengeId = randomToken();
    const challenge = {
      challengeId,
      nonce: randomToken(),
      address,
      chainId,
      issuedAt,
      expiresAt: issuedAt + this.config.challengeTtlMs,
    };
    challenge.message = challengeMessage({
      audience: this.config.audience,
      ...challenge,
    });
    this.challenges.set(challengeId, challenge);
    this.byAddress.set(address, challengeId);
    return { ...challenge };
  }

  consume(challengeId) {
    if (typeof challengeId !== 'string' || challengeId.length > 128) {
      throw new AuthError(401, 'invalid_challenge', 'Invalid or expired authentication challenge');
    }
    const challenge = this.challenges.get(challengeId);
    // Delete before signature verification so concurrent/replayed submissions
    // cannot race through the same one-time credential.
    this.delete(challengeId);
    if (!challenge || challenge.expiresAt <= this.now()) {
      throw new AuthError(401, 'invalid_challenge', 'Invalid or expired authentication challenge');
    }
    return challenge;
  }
}

export class SessionStore {
  constructor(config, now = () => Date.now()) {
    this.config = config;
    this.now = now;
    this.sessions = new Map();
    this.byAddress = new Map();
  }

  identityKey(address) {
    return createHmac('sha256', this.config.identityHmacKey).update(address, 'utf8').digest('hex');
  }

  delete(id) {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session && this.byAddress.get(session.address) === id) {
      this.byAddress.delete(session.address);
    }
  }

  prune() {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt > now) break;
      this.delete(id);
    }
  }

  create(address, chainId, onEvict = () => {}) {
    this.prune();
    const priorId = this.byAddress.get(address);
    if (priorId) {
      onEvict(priorId, 'session_replaced');
      this.delete(priorId);
    }
    while (this.sessions.size >= this.config.maxSessions) {
      const oldestId = this.sessions.keys().next().value;
      if (!oldestId) break;
      onEvict(oldestId, 'session_capacity_replaced');
      this.delete(oldestId);
    }
    const id = randomToken();
    const issuedAt = this.now();
    const session = {
      id,
      address,
      chainId,
      identityKey: this.identityKey(address),
      issuedAt,
      expiresAt: issuedAt + this.config.sessionTtlMs,
    };
    this.sessions.set(id, session);
    this.byAddress.set(address, id);
    return { ...session };
  }

  peek(id) {
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= this.now()) {
      this.delete(id);
      return undefined;
    }
    return session;
  }

  get(id) {
    if (!id) throw new AuthError(401, 'missing_session', 'Wallet authentication is required');
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= this.now()) {
      this.delete(id);
      throw new AuthError(401, 'expired_session', 'Wallet authentication has expired');
    }
    return session;
  }

  requireBound(id, address, chainId) {
    const session = this.get(id);
    if (!equalText(session.address, address || '') || !equalText(session.chainId, chainId || '')) {
      throw new AuthError(403, 'session_binding_mismatch', 'Wallet session does not match this request');
    }
    return session;
  }

  revoke(id) {
    if (id) this.delete(id);
  }
}

export function sessionCookieName(config) {
  return config.cookieSecure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_LOCAL;
}

export function readSessionCookie(request, config) {
  const cookies = request.headers.cookie;
  if (!cookies || cookies.length > 8192) return undefined;
  const name = sessionCookieName(config);
  for (const part of cookies.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function setSessionCookie(response, config, session) {
  const attributes = [
    `${sessionCookieName(config)}=${session.id}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/api/morpheus',
    `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`,
  ];
  if (config.cookieSecure) attributes.push('Secure');
  response.setHeader('Set-Cookie', attributes.join('; '));
}

export function clearSessionCookie(response, config) {
  const attributes = [
    `${sessionCookieName(config)}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/api/morpheus',
    'Max-Age=0',
  ];
  if (config.cookieSecure) attributes.push('Secure');
  response.setHeader('Set-Cookie', attributes.join('; '));
}
