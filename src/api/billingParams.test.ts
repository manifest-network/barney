import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getReservedDomainSuffixes, invalidateReservedDomainSuffixesCache } from './billingParams';
import * as billing from './billing';

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
});
