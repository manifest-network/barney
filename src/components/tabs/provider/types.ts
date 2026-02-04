import type { Lease } from '../../../api/billing';
import type { SKU } from '../../../api/sku';
import type { Coin } from '../../../api/bank';

export interface CreateLeaseForTenantModalProps {
  skus: SKU[];
  onClose: () => void;
  onSubmit: (tenant: string, items: { skuUuid: string; quantity: number }[]) => void | Promise<void>;
  loading: boolean;
}

export interface ProviderLeaseCardProps {
  lease: Lease;
  type: 'pending' | 'active';
  getSKU: (uuid: string) => SKU | undefined;
  onAcknowledge?: () => void;
  onReject?: (reason: string) => void;
  withdrawable?: Coin[];
  onWithdraw?: () => void;
  onClose?: (reason?: string) => void;
  txLoading: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}
