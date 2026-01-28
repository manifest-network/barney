import { REST_URL } from './config';

export interface Coin {
  denom: string;
  amount: string;
}

export interface BalanceResponse {
  balance: Coin;
}

export interface AllBalancesResponse {
  balances: Coin[];
}

export async function getBalance(address: string, denom: string): Promise<Coin> {
  const encodedDenom = encodeURIComponent(denom);
  const response = await fetch(
    `${REST_URL}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodedDenom}`
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch balance: ${response.statusText}`);
  }

  const data: BalanceResponse = await response.json();
  return data.balance ?? { denom, amount: '0' };
}

export async function getAllBalances(address: string): Promise<Coin[]> {
  const response = await fetch(`${REST_URL}/cosmos/bank/v1beta1/balances/${address}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch balances: ${response.statusText}`);
  }

  const data: AllBalancesResponse = await response.json();
  return data.balances ?? [];
}
