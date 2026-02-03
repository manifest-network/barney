import { getQueryClient } from './queryClient';

export interface Coin {
  denom: string;
  amount: string;
}

export async function getBalance(address: string, denom: string): Promise<Coin> {
  const client = await getQueryClient();
  const data = await client.cosmos.bank.v1beta1.balance({ address, denom });
  return (data.balance as unknown as Coin) ?? { denom, amount: '0' };
}

export async function getAllBalances(address: string): Promise<Coin[]> {
  const client = await getQueryClient();
  const data = await client.cosmos.bank.v1beta1.allBalances({ address, resolveDenom: false });
  return (data.balances ?? []) as unknown as Coin[];
}
