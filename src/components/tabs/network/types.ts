import type { Lease, CreditAccount } from '../../../api/billing';
import type { Provider, SKU } from '../../../api/sku';
import type { Coin } from '../../../api/bank';

export type ViewMode = 'leases' | 'credits';

export interface NetworkTabProps {
  isConnected: boolean;
  onConnect: () => void;
  isAdmin: boolean;
}

export interface NetworkLeaseCardProps {
  lease: Lease;
  getProvider: (uuid: string) => Provider | undefined;
  getSKU: (uuid: string) => SKU | undefined;
}

export interface NetworkCreditCardProps {
  account: CreditAccount;
  balances: Coin[];
}
