// @vitest-environment node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { QuotaError, QuotaLedger, estimateSpendMicroUsd } from './ledger.mjs';

const IDENTITY = 'a'.repeat(64);

describe('QuotaLedger', () => {
  let stateFile;
  let config;

  beforeEach(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barney-relay-ledger-'));
    stateFile = join(directory, 'ledger.json');
    config = {
      stateFile,
      identityDailyRequests: 2,
      identityDailyTokens: 100,
      identityDailySpendMicroUsd: 100,
      providerDailyBudgetMicroUsd: 1000,
      maxDailyIdentities: 100,
      inputMicroUsdPerMillionTokens: 1_000_000,
      outputMicroUsdPerMillionTokens: 2_000_000,
    };
  });

  it('durably reserves worst-case usage before a paid request and settles to provider usage', async () => {
    const ledger = new QuotaLedger(config, () => Date.parse('2026-08-27T12:00:00Z'));
    await ledger.init();
    const reservation = await ledger.reserve(IDENTITY, 10, 20);

    expect(reservation.reservedTokens).toBe(30);
    expect(reservation.reservedSpendMicroUsd).toBe(50);
    expect(JSON.parse(await readFile(stateFile, 'utf8')).provider).toEqual({
      requests: 1,
      tokens: 30,
      spendMicroUsd: 50,
    });

    await ledger.settle(reservation, { inputTokens: 4, outputTokens: 3 });
    expect(ledger.snapshot().provider).toEqual({
      requests: 1,
      tokens: 7,
      spendMicroUsd: 10,
    });
  });

  it('enforces identity request/token/spend quotas and the provider hard budget', async () => {
    const requestLedger = new QuotaLedger(config, () => Date.parse('2026-08-27T12:00:00Z'));
    await requestLedger.init();
    await requestLedger.reserve(IDENTITY, 1, 1);
    await requestLedger.reserve(IDENTITY, 1, 1);
    await expect(requestLedger.reserve(IDENTITY, 1, 1)).rejects.toMatchObject({
      status: 429,
      reason: 'identity_request_quota',
    });

    const directory = await mkdtemp(join(tmpdir(), 'barney-relay-budget-'));
    const budgetLedger = new QuotaLedger({
      ...config,
      stateFile: join(directory, 'ledger.json'),
      identityDailyTokens: 10_000,
      identityDailySpendMicroUsd: 10_000,
      providerDailyBudgetMicroUsd: 5,
    }, () => Date.parse('2026-08-27T12:00:00Z'));
    await budgetLedger.init();
    await expect(budgetLedger.reserve(IDENTITY, 2, 2)).rejects.toBeInstanceOf(QuotaError);
    await expect(budgetLedger.reserve(IDENTITY, 2, 2)).rejects.toMatchObject({
      status: 503,
      reason: 'provider_budget_exhausted',
    });
  });

  it('bounds durable identity state by evicting the least-used wallet instead of blocking admission', async () => {
    const secondIdentity = 'b'.repeat(64);
    const thirdIdentity = 'c'.repeat(64);
    const ledger = new QuotaLedger({ ...config, maxDailyIdentities: 2 });
    await ledger.init();
    await ledger.reserve(IDENTITY, 1, 1);
    await ledger.reserve(IDENTITY, 1, 1);
    await ledger.reserve(secondIdentity, 1, 1);
    await ledger.reserve(thirdIdentity, 1, 1);

    expect(Object.keys(ledger.snapshot().identities)).toEqual([IDENTITY, thirdIdentity]);
    expect(ledger.snapshot().provider).toEqual({
      requests: 4,
      tokens: 8,
      spendMicroUsd: 12,
    });
    await expect(ledger.reserve(IDENTITY, 1, 1)).rejects.toMatchObject({
      status: 429,
      reason: 'identity_request_quota',
    });
  });

  it('settles provider accounting safely after a reserved identity is evicted and readmitted', async () => {
    const secondIdentity = 'b'.repeat(64);
    const ledger = new QuotaLedger({ ...config, maxDailyIdentities: 1 });
    await ledger.init();
    const firstReservation = await ledger.reserve(IDENTITY, 1, 1);
    await ledger.reserve(secondIdentity, 1, 1);
    await ledger.reserve(IDENTITY, 1, 1);

    await ledger.settle(firstReservation, { inputTokens: 0, outputTokens: 0 });

    expect(Object.keys(ledger.snapshot().identities)).toEqual([IDENTITY]);
    expect(ledger.snapshot().identities[IDENTITY]).toEqual({
      requests: 1,
      tokens: 2,
      spendMicroUsd: 3,
    });
    expect(ledger.snapshot().provider).toEqual({
      requests: 3,
      tokens: 4,
      spendMicroUsd: 6,
    });
  });

  it('compacts a current ledger when the configured tracking capacity is lowered', async () => {
    const secondIdentity = 'b'.repeat(64);
    await writeFile(stateFile, `${JSON.stringify({
      version: 1,
      window: '2026-08-27',
      provider: { requests: 3, tokens: 6, spendMicroUsd: 9 },
      identities: {
        [IDENTITY]: { requests: 2, tokens: 4, spendMicroUsd: 6 },
        [secondIdentity]: { requests: 1, tokens: 2, spendMicroUsd: 3 },
      },
    })}\n`, 'utf8');
    const ledger = new QuotaLedger(
      { ...config, maxDailyIdentities: 1 },
      () => Date.parse('2026-08-27T12:00:00Z'),
    );

    await ledger.init();

    expect(Object.keys(ledger.snapshot().identities)).toEqual([IDENTITY]);
    expect(ledger.snapshot().provider).toEqual({ requests: 3, tokens: 6, spendMicroUsd: 9 });
  });

  it('rotates an over-capacity prior window after the tracking capacity is lowered', async () => {
    await writeFile(stateFile, `${JSON.stringify({
      version: 1,
      window: '2026-08-26',
      provider: { requests: 2, tokens: 4, spendMicroUsd: 6 },
      identities: {
        [IDENTITY]: { requests: 1, tokens: 2, spendMicroUsd: 3 },
        ['b'.repeat(64)]: { requests: 1, tokens: 2, spendMicroUsd: 3 },
      },
    })}\n`, 'utf8');
    const ledger = new QuotaLedger(
      { ...config, maxDailyIdentities: 1 },
      () => Date.parse('2026-08-27T12:00:00Z'),
    );

    await ledger.init();

    expect(ledger.snapshot()).toEqual({
      version: 1,
      window: '2026-08-27',
      provider: { requests: 0, tokens: 0, spendMicroUsd: 0 },
      identities: {},
    });
  });

  it('uses estimated tokens for identity quota and a separate worst-case spend reservation', async () => {
    const ledger = new QuotaLedger({
      ...config,
      identityDailyTokens: 20,
      identityDailySpendMicroUsd: 1_000,
      providerDailyBudgetMicroUsd: 1_000,
    });
    await ledger.init();
    const reservation = await ledger.reserve(IDENTITY, 5, 5, 100);

    expect(reservation.reservedTokens).toBe(10);
    expect(reservation.reservedIdentitySpendMicroUsd).toBe(15);
    expect(reservation.reservedSpendMicroUsd).toBe(110);
    expect(ledger.snapshot().identities[IDENTITY]).toMatchObject({
      tokens: 10,
      spendMicroUsd: 15,
    });
    expect(ledger.snapshot().provider.spendMicroUsd).toBe(110);

    await ledger.settle(reservation, { inputTokens: 1, outputTokens: 1 });
    expect(ledger.snapshot().identities[IDENTITY].spendMicroUsd).toBe(3);
    expect(ledger.snapshot().provider.spendMicroUsd).toBe(3);
  });

  it('fails closed on a corrupt accounting file instead of resetting spend', async () => {
    await writeFile(stateFile, '{not-json', 'utf8');
    const ledger = new QuotaLedger(config);
    await expect(ledger.init()).rejects.toThrow();
  });

  it('does not publish an in-memory reservation before its durable write succeeds', async () => {
    let failWrites = false;
    const writeState = async (path, value) => {
      if (failWrites) throw new Error('simulated ledger write failure');
      await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    };
    const ledger = new QuotaLedger(config, () => Date.parse('2026-08-27T12:00:00Z'), writeState);
    await ledger.init();
    failWrites = true;

    await expect(ledger.reserve(IDENTITY, 10, 20)).rejects.toThrow('simulated ledger write failure');
    expect(ledger.snapshot().provider).toEqual({ requests: 0, tokens: 0, spendMicroUsd: 0 });
  });

  it('keeps the conservative reservation when settlement cannot be persisted', async () => {
    let failWrites = false;
    const writeState = async (path, value) => {
      if (failWrites) throw new Error('simulated ledger write failure');
      await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    };
    const ledger = new QuotaLedger(config, () => Date.parse('2026-08-27T12:00:00Z'), writeState);
    await ledger.init();
    const reservation = await ledger.reserve(IDENTITY, 10, 20);
    failWrites = true;

    await expect(ledger.settle(reservation, { inputTokens: 1, outputTokens: 1 }))
      .rejects.toThrow('simulated ledger write failure');
    expect(ledger.snapshot().provider).toEqual({ requests: 1, tokens: 30, spendMicroUsd: 50 });
  });

  it('starts a new UTC accounting window without carrying old-window reservations', async () => {
    let now = Date.parse('2026-08-27T23:59:59Z');
    const ledger = new QuotaLedger(config, () => now);
    await ledger.init();
    const oldReservation = await ledger.reserve(IDENTITY, 2, 2);

    now = Date.parse('2026-08-28T00:00:01Z');
    await ledger.rotateIfNeeded();
    await ledger.settle(oldReservation, { inputTokens: 1, outputTokens: 1 });

    expect(ledger.snapshot()).toMatchObject({
      window: '2026-08-28',
      provider: { requests: 0, tokens: 0, spendMicroUsd: 0 },
    });
  });

  it('uses integer micro-dollar arithmetic', () => {
    expect(estimateSpendMicroUsd(config, 1, 1)).toBe(3);
    expect(estimateSpendMicroUsd(config, 1_000_000, 1_000_000)).toBe(3_000_000);
  });
});
