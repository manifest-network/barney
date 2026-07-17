import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockBalance } = vi.hoisted(() => ({
  mockBalance: vi.fn(),
}));

// ENG-537: single-denom bank balance rides the read client's `client.query` LCD
// drop-down (the bound getBalance returns the composite shape, not a Coin).
vi.mock('./readClient', () => ({
  getReadClient: vi.fn().mockResolvedValue({
    query: {
      cosmos: { bank: { v1beta1: { balance: (...a: unknown[]) => mockBalance(...a) } } },
    },
  }),
}));

import { getBalance } from './bank';

beforeEach(() => {
  mockBalance.mockReset();
});

describe('bank.getBalance (single-denom via client.query LCD drop-down)', () => {
  it('returns the queried Coin for an address + denom', async () => {
    mockBalance.mockResolvedValue({ balance: { denom: 'upwr', amount: '5000000' } });
    const coin = await getBalance('manifest1abc', 'upwr');
    expect(mockBalance).toHaveBeenCalledWith({ address: 'manifest1abc', denom: 'upwr' });
    expect(coin).toEqual({ denom: 'upwr', amount: '5000000' });
  });

  it('falls back to a zero Coin when the node returns no balance', async () => {
    mockBalance.mockResolvedValue({ balance: undefined });
    const coin = await getBalance('manifest1abc', 'umfx');
    expect(coin).toEqual({ denom: 'umfx', amount: '0' });
  });
});
