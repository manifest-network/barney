import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getReservedDomainSuffixes, invalidateReservedDomainSuffixesCache } from './billingParams';
import * as billing from './billing';
import { AI_TOOL_API_TIMEOUT_MS } from '../config/constants';

vi.mock('./billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./billing')>();
  return {
    ...actual,
    getBillingParams: vi.fn(),
  };
});

describe('getReservedDomainSuffixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateReservedDomainSuffixesCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the reservedDomainSuffixes list from chain Params', async () => {
    vi.mocked(billing.getBillingParams).mockResolvedValue({
      reservedDomainSuffixes: ['.barney0.manifest0.net', '.foo.test'],
    } as any);

    const suffixes = await getReservedDomainSuffixes();
    expect(suffixes).toEqual(['.barney0.manifest0.net', '.foo.test']);
  });

  it('returns [] when chain Params has no suffixes field', async () => {
    vi.mocked(billing.getBillingParams).mockResolvedValue({} as any);
    expect(await getReservedDomainSuffixes()).toEqual([]);
  });

  it('caches the response across calls', async () => {
    vi.mocked(billing.getBillingParams).mockResolvedValue({
      reservedDomainSuffixes: ['.x'],
    } as any);

    await getReservedDomainSuffixes();
    await getReservedDomainSuffixes();
    await getReservedDomainSuffixes();
    expect(billing.getBillingParams).toHaveBeenCalledTimes(1);
  });

  it('lets a caller stop awaiting the shared cached read without poisoning it', async () => {
    let resolveParams!: (value: Awaited<ReturnType<typeof billing.getBillingParams>>) => void;
    vi.mocked(billing.getBillingParams).mockReturnValueOnce(new Promise((resolve) => {
      resolveParams = resolve;
    }));
    const controller = new AbortController();
    const aborted = getReservedDomainSuffixes(controller.signal);

    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });

    resolveParams({ reservedDomainSuffixes: ['.still-cached'] } as any);
    await expect(getReservedDomainSuffixes()).resolves.toEqual(['.still-cached']);
    expect(billing.getBillingParams).toHaveBeenCalledOnce();
  });

  it('refetches after cache invalidation', async () => {
    vi.mocked(billing.getBillingParams).mockResolvedValue({
      reservedDomainSuffixes: ['.x'],
    } as any);

    await getReservedDomainSuffixes();
    invalidateReservedDomainSuffixesCache();
    await getReservedDomainSuffixes();
    expect(billing.getBillingParams).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures', async () => {
    vi.mocked(billing.getBillingParams).mockRejectedValueOnce(new Error('network'));
    await expect(getReservedDomainSuffixes()).rejects.toThrow('network');

    vi.mocked(billing.getBillingParams).mockResolvedValue({
      reservedDomainSuffixes: ['.recovered'],
    } as any);
    expect(await getReservedDomainSuffixes()).toEqual(['.recovered']);
  });

  // FAIL-FIRST HERO: reproduces the bug from PR #93 Copilot 3243993831.
  // Without `withTimeout` wrapping `getBillingParams()`, a partial-failure LCD
  // (accepts TCP, stalls on /billing/params specifically) returns a promise
  // that never settles. `getReservedDomainSuffixes` then awaits forever,
  // `validateAll` never resolves, and ConfirmationCard's Confirm button stays
  // pinned in `asyncDomainPending` until the user reloads the page.
  // After the fix, the awaited promise rejects within AI_TOOL_API_TIMEOUT_MS
  // (default 15s) with a "timed out" error. `withTimeout` throws a plain
  // `Error` on the timeout path (NOT an `AbortError` — that's reserved for
  // the explicit signal-abort branch in src/api/utils.ts), so the assertion
  // is a substring match on the message.
  it('rejects with a timeout error when getBillingParams never resolves', async () => {
    vi.useFakeTimers();
    vi.mocked(billing.getBillingParams).mockReturnValueOnce(new Promise<never>(() => {}));

    const pending = getReservedDomainSuffixes();
    const settled = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS + 10);
    await settled;
  });

  it('clears the session cache on timeout so the next call re-fetches', async () => {
    vi.useFakeTimers();
    vi.mocked(billing.getBillingParams).mockReturnValueOnce(new Promise<never>(() => {}));

    const failedPromise = getReservedDomainSuffixes();
    const failedAssertion = expect(failedPromise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS + 10);
    await failedAssertion;

    vi.useRealTimers();
    vi.mocked(billing.getBillingParams).mockResolvedValueOnce({
      reservedDomainSuffixes: ['.recovered.net'],
    } as any);
    expect(await getReservedDomainSuffixes()).toEqual(['.recovered.net']);
    expect(billing.getBillingParams).toHaveBeenCalledTimes(2);
  });
});
