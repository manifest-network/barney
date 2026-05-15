import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSignAndBroadcast } = vi.hoisted(() => ({ mockSignAndBroadcast: vi.fn() }));

vi.mock('@cosmjs/stargate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cosmjs/stargate')>();
  return {
    ...actual,
    SigningStargateClient: {
      connectWithSigner: vi.fn().mockResolvedValue({ signAndBroadcast: mockSignAndBroadcast }),
    },
  };
});

import { fundCredit } from './tx';

const fakeSigner = { getAccounts: vi.fn() } as unknown as Parameters<typeof fundCredit>[0];

describe('fundCredit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignAndBroadcast.mockResolvedValue({ code: 0, transactionHash: 'H2', events: [] });
  });

  it('builds MsgFundCredit with the right typeUrl', async () => {
    await fundCredit(fakeSigner, 'sender', 'tenant', { amount: '100', denom: 'umfx' });
    const [, messages] = mockSignAndBroadcast.mock.calls[0];
    expect(messages[0].typeUrl).toBe('/liftedinit.billing.v1.MsgFundCredit');
  });

  it('returns success result with transactionHash on broadcast success', async () => {
    const result = await fundCredit(fakeSigner, 's', 't', { amount: '1', denom: 'umfx' });
    expect(result).toEqual({ success: true, transactionHash: 'H2', events: [] });
  });

  it('returns failure when broadcast returns non-zero code', async () => {
    mockSignAndBroadcast.mockResolvedValue({ code: 5, transactionHash: 'H', rawLog: 'insufficient funds' });
    const result = await fundCredit(fakeSigner, 's', 't', { amount: '1', denom: 'umfx' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('code 5');
      expect(result.transactionHash).toBe('H');
    }
  });

  it('returns failure result on broadcast exception', async () => {
    mockSignAndBroadcast.mockRejectedValue(new Error('network'));
    const result = await fundCredit(fakeSigner, 's', 't', { amount: '1', denom: 'umfx' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('network');
  });
});
