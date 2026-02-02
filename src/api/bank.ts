import { fetchJson, buildUrl } from './utils';

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
  // Note: buildUrl uses URLSearchParams which handles encoding automatically
  const url = buildUrl(`/cosmos/bank/v1beta1/balances/${address}/by_denom`, { denom });
  const data = await fetchJson<BalanceResponse>(url, 'balance');
  return data.balance ?? { denom, amount: '0' };
}

export async function getAllBalances(address: string): Promise<Coin[]> {
  const data = await fetchJson<AllBalancesResponse>(
    `/cosmos/bank/v1beta1/balances/${address}`,
    'balances'
  );
  return data.balances ?? [];
}
