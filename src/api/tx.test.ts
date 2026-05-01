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

import { setItemCustomDomain, fundCredit } from './tx';

const fakeSigner = { getAccounts: vi.fn() } as unknown as Parameters<typeof setItemCustomDomain>[0];

describe('setItemCustomDomain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignAndBroadcast.mockResolvedValue({
      code: 0,
      transactionHash: 'HASH123',
      events: [],
    });
  });

  it('builds MsgSetItemCustomDomain with the right typeUrl and fields', async () => {
    await setItemCustomDomain(fakeSigner, 'manifest1sender', 'lease-uuid-1', 'web', 'app.example.com');

    expect(mockSignAndBroadcast).toHaveBeenCalledTimes(1);
    const [sender, messages] = mockSignAndBroadcast.mock.calls[0];
    expect(sender).toBe('manifest1sender');
    expect(messages).toHaveLength(1);
    expect(messages[0].typeUrl).toBe('/liftedinit.billing.v1.MsgSetItemCustomDomain');
  });

  it('returns success result with transactionHash on broadcast success', async () => {
    const result = await setItemCustomDomain(fakeSigner, 's', 'l', '', 'a.example.com');
    expect(result).toEqual({ success: true, transactionHash: 'HASH123', events: [] });
  });

  it('passes serviceName="" verbatim for legacy single-item leases', async () => {
    await setItemCustomDomain(fakeSigner, 's', 'l', '', 'a.example.com');
    const [, messages] = mockSignAndBroadcast.mock.calls[0];
    expect((messages[0].value as { serviceName: string }).serviceName).toBe('');
  });

  it('passes empty customDomain to clear the field', async () => {
    await setItemCustomDomain(fakeSigner, 's', 'l', 'web', '');
    const [, messages] = mockSignAndBroadcast.mock.calls[0];
    expect((messages[0].value as { customDomain: string }).customDomain).toBe('');
  });

  it('returns failure when broadcast returns non-zero code', async () => {
    mockSignAndBroadcast.mockResolvedValue({ code: 5, transactionHash: 'H', rawLog: 'reserved suffix' });
    const result = await setItemCustomDomain(fakeSigner, 's', 'l', 'web', 'a.example.com');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('code 5');
      expect(result.transactionHash).toBe('H');
    }
  });

  it('returns failure result on broadcast exception', async () => {
    mockSignAndBroadcast.mockRejectedValue(new Error('network'));
    const result = await setItemCustomDomain(fakeSigner, 's', 'l', 'web', 'a.example.com');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('network');
  });
});

describe('fundCredit (regression — verifies shared signAndBroadcast still works)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignAndBroadcast.mockResolvedValue({ code: 0, transactionHash: 'H2', events: [] });
  });

  it('builds MsgFundCredit with the right typeUrl', async () => {
    await fundCredit(fakeSigner, 'sender', 'tenant', { amount: '100', denom: 'umfx' });
    const [, messages] = mockSignAndBroadcast.mock.calls[0];
    expect(messages[0].typeUrl).toBe('/liftedinit.billing.v1.MsgFundCredit');
  });
});
