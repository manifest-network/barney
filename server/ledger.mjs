import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const LEDGER_VERSION = 1;

export class QuotaError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = 'QuotaError';
    this.status = status;
    this.reason = reason;
  }
}

function utcWindow(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function counters() {
  return { requests: 0, tokens: 0, spendMicroUsd: 0 };
}

function emptyState(now) {
  return {
    version: LEDGER_VERSION,
    window: utcWindow(now),
    provider: counters(),
    identities: {},
  };
}

function isCounter(value) {
  return value
    && Number.isSafeInteger(value.requests) && value.requests >= 0
    && Number.isSafeInteger(value.tokens) && value.tokens >= 0
    && Number.isSafeInteger(value.spendMicroUsd) && value.spendMicroUsd >= 0;
}

function validateState(value, maxDailyIdentities) {
  if (!value || value.version !== LEDGER_VERSION || !/^\d{4}-\d{2}-\d{2}$/.test(value.window) || !isCounter(value.provider)) {
    throw new Error('Morpheus relay ledger is invalid; refusing to reset financial accounting');
  }
  if (!value.identities || typeof value.identities !== 'object' || Array.isArray(value.identities)) {
    throw new Error('Morpheus relay ledger identities are invalid; refusing to reset financial accounting');
  }
  if (Object.keys(value.identities).length > maxDailyIdentities) {
    throw new Error('Morpheus relay ledger exceeds the configured identity capacity');
  }
  for (const [identity, usage] of Object.entries(value.identities)) {
    if (!/^[a-f0-9]{64}$/.test(identity) || !isCounter(usage)) {
      throw new Error('Morpheus relay ledger identity entry is invalid; refusing to reset financial accounting');
    }
  }
  return value;
}

function safeAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Morpheus relay accounting overflow');
  return result;
}

function safeSubtract(left, right) {
  const result = left - right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Morpheus relay accounting underflow');
  return result;
}

function ceilCost(tokens, microUsdPerMillionTokens) {
  const numerator = BigInt(tokens) * BigInt(microUsdPerMillionTokens);
  const value = (numerator + 999_999n) / 1_000_000n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Morpheus relay cost estimate overflow');
  return Number(value);
}

export function estimateSpendMicroUsd(config, inputTokens, outputTokens) {
  return safeAdd(
    ceilCost(inputTokens, config.inputMicroUsdPerMillionTokens),
    ceilCost(outputTokens, config.outputMicroUsdPerMillionTokens),
  );
}

async function durableWriteJson(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);

    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export class QuotaLedger {
  constructor(config, now = () => Date.now(), writeState = durableWriteJson) {
    this.config = config;
    this.now = now;
    this.writeState = writeState;
    this.state = undefined;
    this.queue = Promise.resolve();
  }

  async init() {
    try {
      const raw = await readFile(this.config.stateFile, 'utf8');
      this.state = validateState(JSON.parse(raw), this.config.maxDailyIdentities);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const initialState = emptyState(this.now());
      await this.writeState(this.config.stateFile, initialState);
      this.state = initialState;
    }
    await this.rotateIfNeeded();
  }

  withLock(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async rotateIfNeeded() {
    return this.withLock(async () => {
      const window = utcWindow(this.now());
      if (!this.state) throw new Error('Morpheus relay ledger is not initialized');
      if (this.state.window !== window) {
        const nextState = emptyState(this.now());
        await this.writeState(this.config.stateFile, nextState);
        this.state = nextState;
      }
    });
  }

  async reserve(identityKey, inputTokens, outputTokens, worstCaseInputTokens = inputTokens) {
    return this.withLock(async () => {
      if (!this.state) throw new Error('Morpheus relay ledger is not initialized');
      const window = utcWindow(this.now());
      const sourceState = this.state.window === window ? this.state : emptyState(this.now());
      if (!sourceState.identities[identityKey]
        && Object.keys(sourceState.identities).length >= this.config.maxDailyIdentities) {
        throw new QuotaError(503, 'identity_capacity', 'Inference identity capacity is temporarily exhausted');
      }
      const nextState = structuredClone(sourceState);

      const reservedTokens = safeAdd(inputTokens, outputTokens);
      // Token quotas use a realistic tokenizer-independent estimate. Spend
      // quotas use that same estimate. The provider hard budget separately
      // reserves the UTF-8 byte upper bound so it remains safe even for
      // token-dense/non-ASCII input.
      const reservedIdentitySpendMicroUsd = estimateSpendMicroUsd(this.config, inputTokens, outputTokens);
      const reservedSpendMicroUsd = estimateSpendMicroUsd(this.config, worstCaseInputTokens, outputTokens);
      const identity = nextState.identities[identityKey] ?? counters();

      if (identity.requests + 1 > this.config.identityDailyRequests) {
        throw new QuotaError(429, 'identity_request_quota', 'Daily inference request quota exhausted');
      }
      if (identity.tokens + reservedTokens > this.config.identityDailyTokens) {
        throw new QuotaError(429, 'identity_token_quota', 'Daily inference token quota exhausted');
      }
      if (identity.spendMicroUsd + reservedIdentitySpendMicroUsd > this.config.identityDailySpendMicroUsd) {
        throw new QuotaError(429, 'identity_spend_quota', 'Daily inference spend quota exhausted');
      }
      if (nextState.provider.spendMicroUsd + reservedSpendMicroUsd > this.config.providerDailyBudgetMicroUsd) {
        throw new QuotaError(503, 'provider_budget_exhausted', 'Inference is temporarily unavailable');
      }

      identity.requests = safeAdd(identity.requests, 1);
      identity.tokens = safeAdd(identity.tokens, reservedTokens);
      identity.spendMicroUsd = safeAdd(identity.spendMicroUsd, reservedIdentitySpendMicroUsd);
      nextState.identities[identityKey] = identity;
      nextState.provider.requests = safeAdd(nextState.provider.requests, 1);
      nextState.provider.tokens = safeAdd(nextState.provider.tokens, reservedTokens);
      nextState.provider.spendMicroUsd = safeAdd(nextState.provider.spendMicroUsd, reservedSpendMicroUsd);
      await this.writeState(this.config.stateFile, nextState);
      this.state = nextState;

      return Object.freeze({
        window,
        identityKey,
        inputTokens,
        worstCaseInputTokens,
        outputTokens,
        reservedTokens,
        reservedIdentitySpendMicroUsd,
        reservedSpendMicroUsd,
      });
    });
  }

  async settle(reservation, usage) {
    if (!usage) return;
    return this.withLock(async () => {
      if (!this.state || this.state.window !== reservation.window) return;
      const nextState = structuredClone(this.state);
      const identity = nextState.identities[reservation.identityKey];
      if (!identity) throw new Error('Morpheus relay reservation identity is missing');

      const actualTokens = safeAdd(usage.inputTokens, usage.outputTokens);
      const actualSpendMicroUsd = usage.spendMicroUsd ?? estimateSpendMicroUsd(
        this.config,
        usage.inputTokens,
        usage.outputTokens,
      );

      const adjust = (entry, reservedSpendMicroUsd) => {
        entry.tokens = actualTokens >= reservation.reservedTokens
          ? safeAdd(entry.tokens, actualTokens - reservation.reservedTokens)
          : safeSubtract(entry.tokens, reservation.reservedTokens - actualTokens);
        entry.spendMicroUsd = actualSpendMicroUsd >= reservedSpendMicroUsd
          ? safeAdd(entry.spendMicroUsd, actualSpendMicroUsd - reservedSpendMicroUsd)
          : safeSubtract(entry.spendMicroUsd, reservedSpendMicroUsd - actualSpendMicroUsd);
      };
      adjust(identity, reservation.reservedIdentitySpendMicroUsd);
      adjust(nextState.provider, reservation.reservedSpendMicroUsd);
      await this.writeState(this.config.stateFile, nextState);
      this.state = nextState;
    });
  }

  snapshot() {
    if (!this.state) throw new Error('Morpheus relay ledger is not initialized');
    return structuredClone(this.state);
  }
}
