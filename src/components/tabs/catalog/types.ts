import type { Provider, SKU } from '../../../api/sku';

export type HealthStatus = 'healthy' | 'unhealthy' | 'loading' | 'unknown';

export const ITEMS_PER_PAGE = 10;

export interface CatalogTabProps {
  isConnected: boolean;
  address?: string;
  onConnect: () => void;
}

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}

export interface ProviderCardProps {
  provider: Provider;
  isSelected: boolean;
  onSelect: () => void;
  healthStatus?: HealthStatus;
  onEdit?: () => void;
  onDeactivate?: () => void;
}

export interface SKUCardProps {
  sku: SKU;
  providerAddress: string;
  usage?: { active: number; total: number };
  usageLoading?: boolean;
  onEdit?: () => void;
  onDeactivate?: () => void;
}

export interface CreateProviderFormProps {
  defaultAddress?: string;
  onSubmit: (params: { address: string; payoutAddress: string; apiUrl: string }) => void;
  onClose: () => void;
}

export interface CreateSKUFormProps {
  providers: Provider[];
  onSubmit: (params: { providerUuid: string; name: string; unit: number; priceAmount: string; priceDenom: string }) => void;
  onClose: () => void;
}

export interface EditProviderFormProps {
  provider: Provider;
  onSubmit: (params: { uuid: string; address: string; payoutAddress: string; apiUrl: string; active: boolean }) => void;
  onClose: () => void;
}

export interface EditSKUFormProps {
  sku: SKU;
  providers: Provider[];
  onSubmit: (params: { uuid: string; providerUuid: string; name: string; unit: number; priceAmount: string; priceDenom: string; active: boolean }) => void;
  onClose: () => void;
}
