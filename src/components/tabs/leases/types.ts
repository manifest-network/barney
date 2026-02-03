/**
 * Shared types and constants for the Leases tab components.
 */

import type { Lease } from '../../../api/billing';
import type { Provider, SKU } from '../../../api/sku';
import type { LeaseFilterState } from '../../../utils/leaseState';

export interface LeaseCardProps {
  lease: Lease;
  getSKU: (uuid: string) => SKU | undefined;
  getProvider: (uuid: string) => Provider | undefined;
  onCancel: (uuid: string) => void;
  onClose: (uuid: string, reason?: string) => void;
  txLoading: boolean;
  tenantAddress?: string;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}

export interface FilterTabsProps {
  activeFilter: LeaseFilterState;
  onChange: (filter: LeaseFilterState) => void;
  counts: Record<LeaseFilterState, number>;
}

export interface CreateLeaseModalProps {
  providers: Provider[];
  skus: SKU[];
  onClose: () => void;
  onSubmit: (
    items: { skuUuid: string; quantity: number }[],
    payload?: Uint8Array,
    metaHash?: Uint8Array,
    providerUuid?: string
  ) => void;
  loading: boolean;
}

export interface CopyButtonProps {
  value: string;
  copyToClipboard: (text: string) => void;
  isCopied: (text: string) => boolean;
  title?: string;
  stopPropagation?: boolean;
}

/** Number of leases displayed per page */
export const LEASES_PER_PAGE = 10;
