import type { Coin } from '@manifest-network/manifestjs/dist/codegen/cosmos/base/v1beta1/coin';
import { getReadClient } from './readClient';

export type { Coin };

// ENG-537: single-denom bank balance is a 1:1 wire query reached through the read
// client's `client.query` drop-down (manifestjs LCD under the SDK adapter). The
// bound `getBalance` returns the composite (all balances + credits), a different
// shape — so use the raw query for the single-denom Coin.
export async function getBalance(address: string, denom: string): Promise<Coin> {
  const client = await getReadClient();
  const data = await client.query.cosmos.bank.v1beta1.balance({ address, denom });
  return (data.balance as Coin) ?? { denom, amount: '0' };
}
