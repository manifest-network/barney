import type { Coin } from '@manifest-network/manifestjs/dist/codegen/cosmos/base/v1beta1/coin';
import { getQueryClient } from './queryClient';

export type { Coin };

export async function getBalance(address: string, denom: string): Promise<Coin> {
  const client = await getQueryClient();
  const data = await client.cosmos.bank.v1beta1.balance({ address, denom });
  return (data.balance as Coin) ?? { denom, amount: '0' };
}

export async function getAllBalances(address: string): Promise<Coin[]> {
  const client = await getQueryClient();
  const data = await client.cosmos.bank.v1beta1.allBalances({ address, resolveDenom: false });
  return (data.balances ?? []) as Coin[];
}
